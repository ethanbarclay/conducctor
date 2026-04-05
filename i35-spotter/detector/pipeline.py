"""
Four-tier car classification pipeline:
  Tier 1 — YOLO (vehicle detection, bounding boxes — handled in main.py)
  Tier 2 — CLIP ViT-L/14 zero-shot (~50ms, handles most vehicles)
  Tier 3 — Claude Haiku vision API (low-confidence or potentially exotic)
  Tier 4 — Claude Sonnet vision API (truly unknown/exotic, final escalation)
"""

import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from io import BytesIO
from typing import Optional

import anthropic
import clip
import cv2
import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CLIP candidate list — covers common, exotic, and rare vehicles
# ---------------------------------------------------------------------------
CLIP_CANDIDATES = [
    # --- Hypercars ---
    "Bugatti Chiron", "Bugatti Veyron", "Koenigsegg Agera", "Koenigsegg Jesko",
    "Pagani Huayra", "Pagani Zonda", "Rimac Nevera", "Hennessey Venom GT",
    "SSC Tuatara", "McLaren F1", "McLaren Speedtail",
    # --- Supercars ---
    "Ferrari 488", "Ferrari SF90", "Ferrari F8", "Ferrari Roma", "Ferrari 812",
    "Ferrari LaFerrari", "Ferrari Enzo", "Ferrari 458",
    "Lamborghini Huracan", "Lamborghini Urus", "Lamborghini Aventador",
    "Lamborghini Revuelto", "Lamborghini Gallardo",
    "McLaren 720S", "McLaren 765LT", "McLaren Artura", "McLaren 570S",
    "Porsche 911 GT3", "Porsche 911 Turbo", "Porsche 918 Spyder",
    "Porsche Carrera GT", "Porsche Taycan", "Porsche Cayman GT4",
    "Aston Martin Vantage", "Aston Martin DB11", "Aston Martin DBS",
    "Aston Martin Valkyrie", "Aston Martin DB5",
    "Lotus Emira", "Lotus Evija", "Lotus Exige", "Lotus Elise",
    # --- Performance Cars ---
    "Chevrolet Corvette C8 Z06", "Chevrolet Corvette C8",
    "Dodge Viper ACR", "Dodge Challenger SRT Hellcat",
    "Ford GT", "Ford Shelby GT500", "Ford Mustang GT350",
    "BMW M3", "BMW M4", "BMW M5", "BMW M8", "BMW i8",
    "Mercedes-AMG GT", "Mercedes-AMG GT Black Series", "Mercedes-AMG SLS",
    "Mercedes-AMG C63", "Mercedes-AMG E63",
    "Audi R8", "Audi RS3", "Audi RS6 Avant",
    "Lexus LFA", "Lexus LC500", "Lexus RC F",
    "Nissan GT-R Nismo", "Nissan GT-R",
    "Honda NSX", "Honda Civic Type R",
    "Toyota Supra GR", "Toyota GR86", "Toyota GR Corolla",
    "Subaru WRX STI", "Subaru BRZ",
    "Acura NSX", "Acura Integra Type S",
    "Cadillac CT5-V Blackwing", "Cadillac CT4-V Blackwing",
    "Genesis G80 Sport", "Alfa Romeo Giulia Quadrifoglio",
    "Maserati MC20", "Maserati GranTurismo",
    # --- Luxury / Exotic ---
    "Rolls-Royce Phantom", "Rolls-Royce Ghost", "Rolls-Royce Cullinan",
    "Rolls-Royce Wraith", "Rolls-Royce Dawn", "Rolls-Royce Spectre",
    "Bentley Continental GT", "Bentley Bentayga", "Bentley Flying Spur",
    "Maybach S-Class", "Brabus Mercedes", "Brabus G-Class",
    "Mercedes G-Class AMG", "Mercedes G63 AMG", "Mercedes S-Class",
    "Tesla Roadster", "Tesla Model S Plaid", "Tesla Model X",
    # --- Muscle / American ---
    "Ford Mustang Shelby GT500", "Dodge Challenger Demon",
    "Chevrolet Camaro ZL1", "Pontiac GTO", "Pontiac Trans Am",
    "Ford Mustang Boss 302", "Plymouth Barracuda",
    "Dodge Charger Hellcat", "Dodge Challenger Hellcat",
    # --- Classic / Vintage ---
    "Ferrari Testarossa", "Ferrari 308 GTS", "Ferrari F40", "Ferrari F50",
    "Lamborghini Countach", "Lamborghini Diablo", "Lamborghini Murcielago",
    "Porsche 911 classic", "Porsche 356", "Shelby Cobra",
    "Ford GT40", "Jaguar E-Type", "Jaguar XJ220",
    "Chevrolet Corvette C1", "Chevrolet Corvette C2 Stingray",
    "Dodge Viper classic", "BMW E30 M3", "BMW E46 M3",
    "Mercedes 300SL Gullwing", "De Tomaso Pantera",
    # --- Performance Trucks ---
    "Ford F-150 Raptor R", "Ram 1500 TRX", "GMC Hummer EV",
    "Rivian R1T", "Ford F-150 Lightning",
    # --- Common Cars ---
    "Toyota Camry", "Toyota Corolla", "Toyota RAV4", "Toyota Tacoma",
    "Honda Civic", "Honda Accord", "Honda CR-V",
    "Ford F-150", "Ford Explorer", "Ford Escape",
    "Chevrolet Silverado", "Chevrolet Equinox", "Chevrolet Malibu",
    "Tesla Model 3", "Tesla Model Y",
    "Jeep Wrangler", "Jeep Grand Cherokee",
    "Ram 1500", "GMC Sierra",
    "Nissan Altima", "Nissan Rogue",
    "Hyundai Sonata", "Hyundai Tucson", "Kia Sorento",
    "BMW 3 Series", "BMW 5 Series", "BMW X5",
    "Mercedes C-Class", "Mercedes E-Class", "Mercedes GLE",
    "Audi A4", "Audi Q5", "Volkswagen Jetta", "Volkswagen Tiguan",
]

# Makes that are always notable regardless of confidence
EXOTIC_MAKES = {
    "bugatti", "pagani", "koenigsegg", "rimac", "ssc", "hennessey",
    "ferrari", "lamborghini", "mclaren", "porsche", "aston martin",
    "lotus", "rolls-royce", "bentley", "maybach", "maserati",
    "alfa romeo", "de tomaso", "shelby", "jaguar"
}


@dataclass
class ClassificationResult:
    make: Optional[str]
    model: Optional[str]
    year_range: Optional[str]
    trim: Optional[str]
    confidence: float
    tier: int          # 2=CLIP, 3=Claude Haiku, 4=Claude Sonnet
    is_notable: bool
    notable_reason: Optional[str]
    raw_response: Optional[dict] = None


class CarClassificationPipeline:
    # Confidence thresholds
    CLIP_HIGH_CONF  = 0.30   # above this → accept CLIP result
    CLIP_LOW_CONF   = 0.18   # below this → escalate to Haiku
    HAIKU_MIN_CONF  = 0.35   # below this → escalate to Sonnet
    # Haiku confidence < this AND not identifiable → Tier 4
    HAIKU_EXOTIC_THRESHOLD = 0.25

    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Running on device: {self.device}")

        # Tier 2 — CLIP (pre-load at startup, ~2GB VRAM)
        logger.info("Loading CLIP ViT-L/14...")
        self.clip_model, self.clip_preprocess = clip.load("ViT-L/14", device=self.device)
        self.clip_model.eval()

        # Pre-compute text embeddings once
        logger.info(f"Pre-computing text embeddings for {len(CLIP_CANDIDATES)} candidates...")
        with torch.no_grad():
            tokens = clip.tokenize(CLIP_CANDIDATES).to(self.device)
            self.text_features = self.clip_model.encode_text(tokens)
            self.text_features = self.text_features / self.text_features.norm(
                dim=-1, keepdim=True
            )
        logger.info("CLIP ready ✓")

        # Tier 3/4 — Claude
        self.claude = anthropic.Anthropic()
        logger.info("Claude client ready ✓")

    async def classify(self, crop_bgr: np.ndarray) -> ClassificationResult:
        """Main entry: T2 → T3 → T4 escalation chain."""
        pil_img = Image.fromarray(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB))

        # ── Tier 2: CLIP ──────────────────────────────────────────────────
        clip_label, clip_conf, _ = self._clip_classify(pil_img)
        make, model = self._parse_label(clip_label)

        if clip_conf >= self.CLIP_HIGH_CONF:
            is_notable = self._is_notable_by_name(make, model)
            return ClassificationResult(
                make=make, model=model, year_range=None, trim=None,
                confidence=clip_conf, tier=2,
                is_notable=is_notable,
                notable_reason="CLIP high-confidence exotic" if is_notable else None,
            )

        # ── Tier 3: Claude Haiku ─────────────────────────────────────────
        logger.debug(f"CLIP conf={clip_conf:.2f} → Tier 3 Haiku")
        t3 = await self._claude_classify(pil_img, clip_label, clip_conf, model="claude-haiku-4-5")
        t3.tier = 3

        # Accept Haiku result if confident enough OR it successfully IDed an exotic
        if t3.confidence >= self.HAIKU_MIN_CONF or (t3.is_notable and t3.confidence >= 0.20):
            return t3

        # ── Tier 4: Claude Sonnet (truly unknown / exotic) ────────────────
        logger.debug(f"Haiku conf={t3.confidence:.2f} → Tier 4 Sonnet")
        t4 = await self._claude_classify(
            pil_img, clip_label, clip_conf,
            model="claude-sonnet-4-5",
            haiku_hint=t3
        )
        t4.tier = 4
        return t4

    # ── Internal helpers ───────────────────────────────────────────────────

    def _clip_classify(self, pil_img: Image.Image):
        image = self.clip_preprocess(pil_img).unsqueeze(0).to(self.device)
        with torch.no_grad():
            img_features = self.clip_model.encode_image(image)
            img_features = img_features / img_features.norm(dim=-1, keepdim=True)
            sims = (img_features @ self.text_features.T).squeeze(0)
            probs = sims.softmax(dim=-1)
        top_idx = probs.argmax().item()
        return CLIP_CANDIDATES[top_idx], probs[top_idx].item(), top_idx

    def _parse_label(self, label: str):
        """'Ferrari 488 GT3' → ('Ferrari', '488 GT3')"""
        parts = label.split(" ", 1)
        return (parts[0], parts[1]) if len(parts) == 2 else (label, None)

    def _is_notable_by_name(self, make: Optional[str], model: Optional[str]) -> bool:
        if not make:
            return False
        make_l = make.lower()
        if any(e in make_l for e in EXOTIC_MAKES):
            return True
        # Performance models by name
        notable_keywords = [
            "gt3", "gt2", "gt4", "turbo s", "hellcat", "demon", "viper",
            "shelby", "z06", "zl1", "nismo", "type r", "blackwing", "srt",
            "gt350", "gt500", "boss 302", "raptor r", "trx", "plaid",
            "lfa", "nsx", "supra gr", "gr86", "gr corolla"
        ]
        combined = f"{make} {model or ''}".lower()
        return any(k in combined for k in notable_keywords)

    async def _claude_classify(
        self,
        pil_img: Image.Image,
        clip_hint: str,
        clip_conf: float,
        model: str,
        haiku_hint: Optional[ClassificationResult] = None,
    ) -> ClassificationResult:
        buf = BytesIO()
        pil_img.save(buf, format="JPEG", quality=85)
        b64 = base64.standard_b64encode(buf.getvalue()).decode()

        hint_text = f'CLIP suggested "{clip_hint}" ({clip_conf:.0%} confidence).'
        if haiku_hint and haiku_hint.make:
            hint_text += f' Claude Haiku suggested "{haiku_hint.make} {haiku_hint.model}" ({haiku_hint.confidence:.0%}).'

        prompt = f"""You are an elite automotive identifier with encyclopedic knowledge of every vehicle ever made, including rare, exotic, classic, and prototype vehicles.

{hint_text}

Identify the vehicle in the image as precisely as possible. Look for:
- Body shape, proportions, stance
- Headlight / taillight design
- Grille shape and badge
- Wheel arch shape, body lines
- Roof line and greenhouse shape
- Any visible badges, vents, or distinctive features

Return ONLY valid JSON with these exact fields:
{{
  "make": "manufacturer or null",
  "model": "model name or null",
  "year_range": "e.g. 2020-2023 or null",
  "trim": "specific trim/variant if visible or null",
  "confidence": 0-100,
  "is_notable": true/false,
  "notable_reason": "concise reason if notable else null"
}}

is_notable = true if the vehicle is: exotic, rare, high-performance, classic, limited edition, or otherwise unusual on a public highway.
Do not output any text outside the JSON object."""

        try:
            response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: self.claude.messages.create(
                    model=model,
                    max_tokens=300,
                    messages=[{
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {
                                "type": "base64", "media_type": "image/jpeg", "data": b64
                            }},
                            {"type": "text", "text": prompt}
                        ]
                    }]
                )
            )
            raw_text = response.content[0].text.strip()
            # Strip markdown code fences if present
            if raw_text.startswith("```"):
                raw_text = raw_text.split("```")[1]
                if raw_text.startswith("json"):
                    raw_text = raw_text[4:]
            data = json.loads(raw_text)
            return ClassificationResult(
                make=data.get("make"),
                model=data.get("model"),
                year_range=data.get("year_range"),
                trim=data.get("trim"),
                confidence=data.get("confidence", 0) / 100.0,
                tier=3,
                is_notable=data.get("is_notable", False),
                notable_reason=data.get("notable_reason"),
                raw_response=data,
            )
        except Exception as e:
            logger.error(f"Claude {model} classification failed: {e}")
            make, model_name = self._parse_label(clip_hint)
            return ClassificationResult(
                make=make, model=model_name, year_range=None, trim=None,
                confidence=clip_conf, tier=2,
                is_notable=False, notable_reason=None,
            )
