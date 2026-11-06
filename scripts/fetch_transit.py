import urllib.request
import urllib.parse
import json
import os

def fetch_transit():
    os.makedirs("public/data", exist_ok=True)
    # Query route relations for subway and commuter rail (LIRR, Metro-North, SIR) in NYC + Westchester + Nassau
    query = """
    [out:json][timeout:60];
    (
      rel["route"="subway"](40.48,-74.30,41.05,-73.50);
      rel["route"="light_rail"]["network"~"MTA|PATH",i](40.48,-74.30,41.05,-73.50);
      rel["route"="train"]["network"~"LIRR|Long Island|Metro-North|MTA|SIR|Staten Island",i](40.48,-74.30,41.05,-73.50);
      rel["route"="train"]["operator"~"Long Island|Metro-North|MTA|Staten Island",i](40.48,-74.30,41.05,-73.50);
    );
    out geom;
    """
    url = "https://overpass-api.de/api/interpreter"
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "NYCWalksMapApp/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = json.loads(resp.read().decode("utf-8"))

    subway_features = []
    rail_features = []
    seen_ways = set()

    for el in raw.get("elements", []):
        if el.get("type") != "relation":
            continue
        tags = el.get("tags", {})
        route_type = tags.get("route", "")
        name = tags.get("name", "") or tags.get("ref", "Transit Line")
        ref = tags.get("ref", "")
        color = tags.get("colour", "") or tags.get("color", "")
        network = tags.get("network", "") or tags.get("operator", "")

        is_subway = route_type == "subway" or "Staten Island Railway" in name or "SIR" in ref
        if not color:
            color = "#0097A7" if is_subway else "#7E57C2"

        lines = []
        for member in el.get("members", []):
            if member.get("type") == "way" and "geometry" in member:
                role = member.get("role", "")
                if "platform" in role:
                    continue
                way_id = (is_subway, member.get("ref"))
                if way_id in seen_ways:
                    continue
                seen_ways.add(way_id)
                coords = [[round(pt["lon"], 5), round(pt["lat"], 5)] for pt in member["geometry"]]
                if len(coords) >= 2:
                    lines.append(coords)

        if not lines:
            continue

        feat = {
            "type": "Feature",
            "properties": {
                "id": f"rel-{el.get('id')}",
                "name": name,
                "ref": ref,
                "color": color,
                "network": network,
                "category": "subway" if is_subway else "rail"
            },
            "geometry": {
                "type": "MultiLineString",
                "coordinates": lines
            }
        }
        if is_subway:
            subway_features.append(feat)
        else:
            rail_features.append(feat)

    with open("public/data/transit-subway.geojson", "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": subway_features}, f)

    with open("public/data/transit-rail.geojson", "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": rail_features}, f)

    print(f"Saved {len(subway_features)} subway route relations and {len(rail_features)} commuter rail (LIRR/Metro-North) route relations.")

if __name__ == "__main__":
    fetch_transit()
