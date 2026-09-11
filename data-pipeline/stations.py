"""Sensor station registry shared by both synthetic data generators.

Coordinates are approximate (illustrative, not survey-grade) placements of real
Sikkim settlements along the Teesta / North Sikkim corridor referenced in the
PS-7 pitch deck. basin_km is the along-river distance downstream from South
Lhonak Lake, used by the cloudburst/GLOF generator to compute flood-wave
propagation lag. Stations with has_water_level=False sit off the Teesta flood
path and act as rainfall/seismic reference points only.
"""

STATIONS = [
    {
        "id": "lachen",
        "name": "Lachen",
        "lat": 27.7167,
        "lon": 88.5567,
        "basin_km": 0,
        "role": "upstream_catchment",
        "has_water_level": True,
        "water_body": "South Lhonak Lake",
    },
    {
        "id": "chungthang",
        "name": "Chungthang",
        "lat": 27.6167,
        "lon": 88.6500,
        "basin_km": 18,
        "role": "dam_site",
        "has_water_level": True,
        "water_body": "Teesta River",
    },
    {
        "id": "mangan",
        "name": "Mangan",
        "lat": 27.5167,
        "lon": 88.5333,
        "basin_km": 32,
        "role": "district_hq",
        "has_water_level": True,
        "water_body": "Teesta River",
    },
    {
        "id": "dikchu",
        "name": "Dikchu",
        "lat": 27.3833,
        "lon": 88.6167,
        "basin_km": 55,
        "role": "midstream",
        "has_water_level": True,
        "water_body": "Teesta River",
    },
    {
        "id": "singtam",
        "name": "Singtam",
        "lat": 27.2333,
        "lon": 88.4833,
        "basin_km": 70,
        "role": "downstream",
        "has_water_level": True,
        "water_body": "Teesta River",
    },
    {
        "id": "gangtok",
        "name": "Gangtok",
        "lat": 27.3389,
        "lon": 88.6065,
        "basin_km": None,
        "role": "reference",
        "has_water_level": False,
        "water_body": None,
    },
    {
        "id": "gyalshing",
        "name": "Gyalshing",
        "lat": 27.2833,
        "lon": 88.2667,
        "basin_km": None,
        "role": "reference",
        "has_water_level": False,
        "water_body": None,
    },
]

# Synthetic epicenter for the earthquake scenario — not tied to a real recorded
# event, placed near Mangan on the North Sikkim fault zone referenced in the deck.
EARTHQUAKE_EPICENTER = {"lat": 27.5500, "lon": 88.5500, "label": "North Sikkim fault zone (synthetic)"}

SIM_START = "2023-10-02 00:00:00"
SIM_END = "2023-10-06 23:50:00"
