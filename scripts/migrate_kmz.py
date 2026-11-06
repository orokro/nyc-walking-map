import zipfile
import xml.etree.ElementTree as ET
import json
import re
import math
import os

def haversine_miles(coord1, coord2):
    lon1, lat1 = coord1[0], coord1[1]
    lon2, lat2 = coord2[0], coord2[1]
    R = 3958.7613  # Earth radius in miles
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))

def compute_line_miles(coords):
    if len(coords) < 2:
        return 0.0
    total = 0.0
    for i in range(len(coords) - 1):
        total += haversine_miles(coords[i], coords[i + 1])
    return round(total, 2)

def kml_color_to_hex(kml_color):
    # KML color is aabbggrr
    if not kml_color or len(kml_color) != 8:
        return "#0288D1"
    rr = kml_color[6:8]
    gg = kml_color[4:6]
    bb = kml_color[2:4]
    return f"#{rr}{gg}{bb}".upper()

def parse_date_and_title(raw_name, folder_name):
    name = (raw_name or "").strip()
    # Match YYYY-MM-DD or YYYY_MM_DD or YY-MM-DD at start
    m = re.match(r'^(\d{2,4})[-_](\d{1,2})[-_](\d{1,2})\s*(.*)$', name)
    if m:
        yr_str, mo_str, da_str, rest = m.groups()
        yr = int(yr_str)
        if yr < 100:
            yr += 2000
        mo = int(mo_str)
        da = int(da_str)
        iso_date = f"{yr:04d}-{mo:02d}-{da:02d}"
        title = rest.strip(" -_:") or f"Walk on {iso_date}"
        return iso_date, title, str(yr)
    # Fallback if no date prefix
    yr_match = re.search(r'(20\d{2})', folder_name)
    inferred_yr = yr_match.group(1) if yr_match else ""
    return "", name or "Untitled Walk", inferred_yr

def migrate():
    os.makedirs("public/data", exist_ok=True)
    with zipfile.ZipFile("Walks.kmz", "r") as z:
        kml_bytes = z.read("doc.kml")
    root = ET.fromstring(kml_bytes)
    ns = {"kml": "http://www.opengis.net/kml/2.2"}

    # Parse styles
    styles = {}
    for st in root.findall(".//kml:Style", ns):
        st_id = st.attrib.get("id", "")
        color_el = st.find(".//kml:LineStyle/kml:color", ns)
        width_el = st.find(".//kml:LineStyle/kml:width", ns)
        color_hex = kml_color_to_hex(color_el.text.strip()) if color_el is not None and color_el.text else "#0288D1"
        width_val = float(width_el.text.strip()) if width_el is not None and width_el.text else 3.0
        styles[f"#{st_id}"] = {"color": color_hex, "width": width_val}

    style_maps = {}
    for sm in root.findall(".//kml:StyleMap", ns):
        sm_id = sm.attrib.get("id", "")
        for pair in sm.findall("kml:Pair", ns):
            k = pair.find("kml:key", ns)
            u = pair.find("kml:styleUrl", ns)
            if k is not None and k.text == "normal" and u is not None and u.text:
                style_maps[f"#{sm_id}"] = styles.get(u.text.strip(), {"color": "#0288D1", "width": 3.0})

    borough_features = []
    walks = []
    walk_idx = 1

    for folder in root.findall(".//kml:Folder", ns):
        fname_el = folder.find("kml:name", ns)
        folder_name = fname_el.text.strip() if fname_el is not None and fname_el.text else "Uncategorized"

        for pm in folder.findall("kml:Placemark", ns):
            pname_el = pm.find("kml:name", ns)
            raw_name = pname_el.text.strip() if pname_el is not None and pname_el.text else "Untitled"
            desc_el = pm.find("kml:description", ns)
            notes = desc_el.text.strip() if desc_el is not None and desc_el.text else ""
            surl_el = pm.find("kml:styleUrl", ns)
            surl = surl_el.text.strip() if surl_el is not None and surl_el.text else ""
            st_info = style_maps.get(surl) or styles.get(surl) or {"color": "#0288D1", "width": 3.0}

            coords_el = pm.find(".//kml:LineString/kml:coordinates", ns)
            if coords_el is None or not coords_el.text:
                continue

            coords = []
            for pt in coords_el.text.strip().split():
                parts = pt.split(",")
                if len(parts) >= 2:
                    lon = round(float(parts[0]), 6)
                    lat = round(float(parts[1]), 6)
                    coords.append([lon, lat])

            if len(coords) < 2:
                continue

            if folder_name.lower() == "borough lines":
                borough_features.append({
                    "type": "Feature",
                    "properties": {
                        "id": f"borough-{raw_name.lower().replace(' ', '-')}",
                        "name": raw_name,
                        "color": st_info["color"],
                        "width": 3.0
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coords
                    }
                })
                continue

            iso_date, clean_title, year_str = parse_date_and_title(raw_name, folder_name)
            is_subway = (folder_name == "Subway Walks")
            is_planned = folder_name in ("To Walk", "Other")
            status = "planned" if is_planned else "completed"
            dist_miles = compute_line_miles(coords)

            # Determine manualLayerId if any
            manual_layer = ""
            if folder_name == "Other":
                manual_layer = "other"

            walks.append({
                "id": f"walk-{walk_idx:04d}",
                "title": clean_title,
                "date": iso_date,
                "year": year_str or (iso_date[:4] if iso_date else "Planned"),
                "status": status,
                "isSubwayWalk": is_subway,
                "manualLayerId": manual_layer,
                "originalFolder": folder_name,
                "originalColor": st_info["color"],
                "distanceMiles": dist_miles,
                "notes": notes,
                "coordinates": coords
            })
            walk_idx += 1

    # Sort walks chronologically (with undated at the end)
    walks.sort(key=lambda w: (w["date"] if w["date"] else "9999-99-99", w["id"]))

    borough_geojson = {
        "type": "FeatureCollection",
        "features": borough_features
    }

    with open("public/data/borough-lines.geojson", "w", encoding="utf-8") as f:
        json.dump(borough_geojson, f, indent=2)

    dataset = {
        "version": 1,
        "updatedAt": "2026-11-05T17:22:00Z",
        "settings": {
            "completedWalkColor": "#0288D1",
            "completedWalkWidth": 3.2,
            "completedWalkOpacity": 0.9,
            "subwayWalkColor": "#0097A7",
            "subwayWalkWidth": 3.2,
            "subwayWalkOpacity": 0.9,
            "plannedWalkColor": "#FF6D00",
            "plannedWalkWidth": 4.0,
            "boroughLineColor": "#E65100",
            "boroughLineWidth": 2.5,
            "showBoroughLines": True,
            "showSubwayLines": False,
            "showCommuterRail": False,
            "colorMode": "uniform"
        },
        "manualLayers": [
            {"id": "other", "name": "Other / Scratch", "color": "#7E57C2", "visible": True}
        ],
        "walks": walks
    }

    with open("public/data/walks.json", "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2)

    total_miles = sum(w["distanceMiles"] for w in walks if w["status"] == "completed")
    subway_miles = sum(w["distanceMiles"] for w in walks if w["isSubwayWalk"])
    planned_miles = sum(w["distanceMiles"] for w in walks if w["status"] == "planned")
    print(f"Migrated {len(walks)} walks and {len(borough_features)} borough boundaries.")
    print(f"Completed Miles: {total_miles:.1f} mi (including {subway_miles:.1f} mi Subway Walks)")
    print(f"Planned Miles: {planned_miles:.1f} mi")

if __name__ == "__main__":
    migrate()
