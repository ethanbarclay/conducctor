FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

WORKDIR /app

# System deps for OpenCV + CLIP
RUN apt-get update && apt-get install -y --no-install-recommends \
    git libglib2.0-0 libsm6 libxext6 libxrender-dev libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download YOLO weights at build time
RUN python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

# Pre-download CLIP weights at build time
RUN python -c "import clip; clip.load('ViT-L/14', device='cpu')"

COPY . .

CMD ["python", "main.py"]
