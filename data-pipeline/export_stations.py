import json
from pathlib import Path

from stations import STATIONS, EARTHQUAKE_EPICENTER

OUT_DIR = Path(__file__).parent / "output"


def main():
    OUT_DIR.mkdir(exist_ok=True)
    with open(OUT_DIR / "stations.json", "w") as f:
        json.dump({"stations": STATIONS, "earthquake_epicenter": EARTHQUAKE_EPICENTER}, f, indent=2)
    print(f"wrote {len(STATIONS)} stations")


if __name__ == "__main__":
    main()
