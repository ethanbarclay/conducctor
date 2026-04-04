"""
Seed the car_specs table with HP, 0-60, production data.
Run once: python seed_specs.py

Data is hardcoded for the cars that matter most for spotting —
exotics, hypercars, performance cars. Mass-market cars get NULL specs
(they don't affect scoring much anyway).
"""

import asyncio
import os
import asyncpg

DB_URL = os.environ.get("DB_URL", "postgresql://spotter:changeme@localhost:5432/i35spotter")

# Format: (make, model, year_start, year_end, hp, torque_lb_ft, 0_60, top_speed_mph, production_count, msrp_usd, category, rarity_tier)
SPECS = [
    # ── Hypercars ──────────────────────────────────────────────────────────────
    ("Bugatti",    "Chiron",               2016, 2023,  1479, 1180, 2.4, 261,    500,  2900000, "hypercar", 5),
    ("Bugatti",    "Veyron",               2005, 2015,  1001,  922, 2.5, 253,    450,  1700000, "hypercar", 5),
    ("Bugatti",    "Tourbillon",           2026, 2030,  1800, None, 2.0, 277,    250,  3800000, "hypercar", 5),
    ("Koenigsegg", "Jesko Absolut",        2020, 2030,  1600, 1106, 2.5, 330,    125,  3000000, "hypercar", 5),
    ("Koenigsegg", "Agera RS",             2015, 2018,  1341, 1011, 2.8, 278,     25,  2100000, "hypercar", 5),
    ("Pagani",     "Huayra R",             2021, 2025,   850,  553, 2.7, 230,     30,  3100000, "hypercar", 5),
    ("Pagani",     "Zonda",                2000, 2017,   760,  575, 3.4, 220,    140,  1500000, "hypercar", 5),
    ("Rimac",      "Nevera",               2021, 2030,  1914, 1741, 1.85,258,    150,  2200000, "hypercar", 5),
    ("Hennessey",  "Venom F5",             2021, 2025,  1817, 1193, 2.6, 311,     24,  2100000, "hypercar", 5),
    ("SSC",        "Tuatara",              2020, 2025,  1750, 1280, 2.5, 295,     100,  1600000, "hypercar", 5),
    ("McLaren",    "F1",                   1992, 1998,   627,  479, 3.2, 240,    106,  1000000, "hypercar", 5),
    ("McLaren",    "Speedtail",            2020, 2022,  1055,  848, 2.9, 250,    106,  2250000, "hypercar", 5),

    # ── Ferrari ────────────────────────────────────────────────────────────────
    ("Ferrari",    "SF90 Stradale",        2020, 2025,   986,  590, 2.5, 211,    None,  507000, "supercar", 4),
    ("Ferrari",    "LaFerrari",            2013, 2016,   949,  664, 2.9, 217,    499, 1400000, "supercar", 4),
    ("Ferrari",    "F8 Tributo",           2019, 2023,   710,  568, 2.9, 211,    None,  276000, "supercar", 4),
    ("Ferrari",    "488 Pista",            2018, 2020,   710,  568, 2.85,211,   None,  330000, "supercar", 4),
    ("Ferrari",    "488 GTB",              2015, 2019,   660,  560, 3.0, 205,    None,  252000, "supercar", 4),
    ("Ferrari",    "812 Superfast",        2017, 2022,   789,  530, 2.9, 211,    None,  335000, "supercar", 4),
    ("Ferrari",    "812 Competizione",     2021, 2024,   819,  514, 2.85,211,    999,  550000, "supercar", 4),
    ("Ferrari",    "Roma",                 2020, 2025,   611,  561, 3.4, 199,    None,  222000, "supercar", 4),
    ("Ferrari",    "296 GTB",              2021, 2025,   818,  546, 2.9, 205,    None,  323000, "supercar", 4),
    ("Ferrari",    "Enzo",                 2002, 2004,   651,  485, 3.65,218,    400,  660000, "supercar", 4),
    ("Ferrari",    "F40",                  1987, 1992,   478,  424, 3.8, 201,   1311,  400000, "supercar", 4),
    ("Ferrari",    "F50",                  1995, 1997,   513,  347, 3.7, 202,    349,  550000, "supercar", 4),
    ("Ferrari",    "Testarossa",           1984, 1996,   390,  362, 5.2, 180,   7177,   90000, "supercar", 4),

    # ── Lamborghini ────────────────────────────────────────────────────────────
    ("Lamborghini","Revuelto",             2023, 2030,  1001,  535, 2.5, 217,    None,  600000, "supercar", 4),
    ("Lamborghini","Aventador SVJ",        2018, 2022,   759,  531, 2.8, 217,    900,   518000, "supercar", 4),
    ("Lamborghini","Huracan STO",          2021, 2024,   631,  417, 3.0, 193,   1499,   330000, "supercar", 4),
    ("Lamborghini","Huracan Performante",  2017, 2022,   631,  442, 2.9, 201,    None,  274000, "supercar", 4),
    ("Lamborghini","Urus Performante",     2022, 2025,   657,  627, 3.3, 193,    None,  242000, "supercar", 4),
    ("Lamborghini","Countach LPI 800-4",   2021, 2022,   803,  539, 2.8, 221,    112,  2000000, "supercar", 5),
    ("Lamborghini","Murcielago LP 670",    2009, 2010,   661,  487, 3.2, 212,    186,   450000, "supercar", 4),

    # ── McLaren ────────────────────────────────────────────────────────────────
    ("McLaren",    "720S",                 2017, 2023,   710,  568, 2.8, 212,    None,  300000, "supercar", 4),
    ("McLaren",    "765LT",                2020, 2022,   755,  590, 2.7, 205,    765,   358000, "supercar", 4),
    ("McLaren",    "Artura",               2022, 2025,   671,  531, 3.0, 205,    None,  237000, "supercar", 4),
    ("McLaren",    "Senna",                2018, 2019,   789,  590, 2.7, 208,    500,   1000000, "supercar", 4),
    ("McLaren",    "570S",                 2015, 2022,   562,  443, 3.1, 204,    None,  198000, "supercar", 4),
    ("McLaren",    "P1",                   2013, 2015,   903,  664, 2.8, 217,    375,  1150000, "hypercar", 5),

    # ── Porsche ────────────────────────────────────────────────────────────────
    ("Porsche",    "911 GT3 RS",           2023, 2025,   518,  343, 3.0, 184,    None,  225000, "supercar", 4),
    ("Porsche",    "911 GT3",              2021, 2025,   502,  347, 3.4, 197,    None,  162000, "supercar", 4),
    ("Porsche",    "911 Turbo S",          2020, 2025,   640,  590, 2.6, 205,    None,  207000, "supercar", 4),
    ("Porsche",    "918 Spyder",           2013, 2015,   887,  944, 2.5, 214,    918,   845000, "hypercar", 5),
    ("Porsche",    "Carrera GT",           2003, 2006,   605,  435, 3.9, 205,   1270,   440000, "supercar", 4),
    ("Porsche",    "Cayman GT4 RS",        2021, 2025,   493,  309, 3.4, 196,    None,  148000, "supercar", 4),
    ("Porsche",    "Taycan Turbo GT",      2024, 2025,  1019,  1000, 2.1, 190,    None,  190000, "supercar", 4),

    # ── Aston Martin ───────────────────────────────────────────────────────────
    ("Aston Martin","Valkyrie",            2021, 2024,  1160,  664, 2.5, 217,    150,  3100000, "hypercar", 5),
    ("Aston Martin","DBS Superleggera",    2018, 2023,   715,  664, 3.4, 211,    None,  316000, "supercar", 4),
    ("Aston Martin","Vantage",             2018, 2025,   503,  505, 3.6, 195,    None,  150000, "supercar", 4),
    ("Aston Martin","DB11 AMR",            2018, 2023,   630,  516, 3.5, 208,    None,  218000, "supercar", 4),
    ("Aston Martin","One-77",              2009, 2012,   750,  553, 3.5, 220,     77,  1850000, "hypercar", 5),

    # ── American Performance ───────────────────────────────────────────────────
    ("Chevrolet",  "Corvette Z06",         2023, 2025,   670,  460, 2.6, 196,    None,  109000, "supercar", 4),
    ("Chevrolet",  "Corvette C8",          2020, 2025,   495,  470, 2.9, 194,    None,   67000, "sports",   3),
    ("Chevrolet",  "Corvette ZR1",         2024, 2025,  1064,  828, 2.4, 215,    None,  170000, "supercar", 4),
    ("Dodge",      "Viper ACR",            2016, 2017,   645,  600, 3.5, 177,    360,   120000, "supercar", 4),
    ("Dodge",      "Challenger SRT Demon 170",2023,2023, 1025, 945, 1.66,168,   3300,   100000, "muscle",   4),
    ("Ford",       "GT",                   2017, 2022,   647,  550, 3.0, 216,    350,   500000, "supercar", 4),
    ("Ford",       "Shelby GT500",         2020, 2023,   760,  625, 3.3, 180,    None,   74000, "muscle",   3),
    ("Cadillac",   "CT5-V Blackwing",      2022, 2025,   668,  659, 3.7, 200,    None,   92000, "sports",   3),

    # ── German Performance ─────────────────────────────────────────────────────
    ("BMW",        "M3 CS",                2023, 2025,   543,  479, 3.4, 187,    None,  113000, "sports",   3),
    ("BMW",        "M4 CSL",               2022, 2024,   543,  479, 3.6, 188,   1000,   140000, "sports",   3),
    ("BMW",        "M5 CS",                2021, 2023,   627,  553, 3.0, 189,   1000,   145000, "sports",   3),
    ("BMW",        "i8",                   2014, 2020,   369,  420, 4.2, 155,    None,   148000, "sports",  3),
    ("Mercedes-AMG","GT Black Series",     2020, 2023,   720,  590, 3.1, 202,    900,   335000, "supercar", 4),
    ("Mercedes-AMG","GT 63 S E Performance",2023,2025,  831,  1033, 2.9, 196,    None,  190000, "supercar", 4),
    ("Mercedes-AMG","SLS",                 2010, 2014,   563,  479, 3.7, 197,    None,  185000, "supercar", 4),
    ("Audi",       "R8 V10 Performance",   2019, 2023,   620,  428, 3.1, 205,    None,  196000, "supercar", 4),

    # ── Japanese Performance ───────────────────────────────────────────────────
    ("Nissan",     "GT-R Nismo",           2014, 2023,   600,  481, 2.8, 196,    None,  215000, "supercar", 4),
    ("Nissan",     "GT-R",                 2008, 2023,   565,  467, 2.9, 196,    None,  116000, "sports",   3),
    ("Honda",      "NSX",                  2016, 2022,   573,  476, 3.1, 191,    None,  157000, "supercar", 4),
    ("Honda",      "NSX Classic",          1991, 2005,   270,  210, 5.7, 168,    18000,  62000, "sports",   3),
    ("Lexus",      "LFA",                  2010, 2012,   552,  354, 3.7, 202,    500,   375000, "supercar", 4),
    ("Toyota",     "GR Supra A91-CF",      2022, 2023,   382,  368, 4.1, 155,    596,   65000, "sports",    3),
    ("Toyota",     "GR Supra",             2019, 2023,   382,  368, 3.9, 155,    None,  57000, "sports",    3),

    # ── Luxury / Rolls / Bentley ───────────────────────────────────────────────
    ("Rolls-Royce","Phantom",              2017, 2025,   563,  664, 5.3, 155,    None,  460000, "luxury",   3),
    ("Rolls-Royce","Cullinan Black Badge", 2021, 2025,   592,  664, 5.0, 155,    None,  430000, "luxury",   3),
    ("Rolls-Royce","Spectre",              2023, 2025,   577,  664, 4.5, 155,    None,  413000, "luxury",   3),
    ("Bentley",    "Continental GT Speed", 2022, 2025,   650,  664, 3.5, 208,    None,  274000, "luxury",   3),
    ("Bentley",    "Mulliner Bacalar",     2021, 2022,   650,  664, 3.5, 208,      12,  1500000,"luxury",   5),

    # ── EVs worth noting ──────────────────────────────────────────────────────
    ("Tesla",      "Roadster",             2023, 2027,   1000, None, 1.9, 250,    None,  200000, "supercar", 4),
    ("Tesla",      "Model S Plaid",        2021, 2025,   1020, 1050, 1.99,200,   None,   90000, "sports",   3),
    ("Rivian",     "R1T Performance",      2021, 2025,   835, 908, 3.0, 135,     None,  73000, "truck",    2),
    ("GMC",        "Hummer EV Edition 1",  2021, 2022,  1000, 11500, 3.0,106,    None,  112595,"truck",    3),

    # ── Classic / Vintage ─────────────────────────────────────────────────────
    ("Ford",       "GT40",                 1964, 1969,   485,  None, 4.0, 200,    133,  5000000, "classic", 5),
    ("Shelby",     "Cobra 427",            1965, 1967,   425,  480, 4.2, 165,    356,  1000000, "classic",  5),
    ("Jaguar",     "XJ220",                1992, 1994,   542,  475, 3.8, 212,    281,  500000,  "supercar", 4),
    ("Jaguar",     "E-Type",               1961, 1975,   265,  260, 7.0, 150,   72507,  30000,  "classic",  3),
    ("De Tomaso",  "Pantera",              1971, 1993,   330,  325, 5.5, 159,   7260,   20000,  "classic",  3),
]


async def seed():
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=3)
    async with pool.acquire() as conn:
        # Upsert all specs
        await conn.executemany(
            """INSERT INTO car_specs
               (make, model, year_start, year_end, hp, torque_lb_ft, zero_to_60,
                top_speed_mph, production_count, msrp_usd, category, rarity_tier)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               ON CONFLICT (make, model, year_start) DO UPDATE SET
                 year_end=EXCLUDED.year_end, hp=EXCLUDED.hp,
                 torque_lb_ft=EXCLUDED.torque_lb_ft, zero_to_60=EXCLUDED.zero_to_60,
                 top_speed_mph=EXCLUDED.top_speed_mph,
                 production_count=EXCLUDED.production_count,
                 msrp_usd=EXCLUDED.msrp_usd, category=EXCLUDED.category,
                 rarity_tier=EXCLUDED.rarity_tier""",
            SPECS
        )
        count = await conn.fetchval("SELECT COUNT(*) FROM car_specs")
        print(f"✅ car_specs table seeded: {count} entries")
    await pool.close()


if __name__ == "__main__":
    asyncio.run(seed())
