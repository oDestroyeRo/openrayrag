#!/usr/bin/env python3
"""Build compact metadata from the official client's public JSON exports.

Usage: python3 scripts/build-game-catalog.py INPUT_DIRECTORY OUTPUT_FILE
Inputs: items.json, skillinfo.json, skilltree.json. No client code is executed.
"""
import hashlib
import json
from pathlib import Path
import sys

from catalog_effects import write_catalog
from catalog_logic import catalog_json

INPUTS = ("items", "skillinfo", "skilltree")


def number(value, low=0, high=2147483647):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("Invalid catalog number")
    return value


def name(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(ord(c) < 32 for c in value):
        raise ValueError("Invalid catalog name")
    return value


def build_catalog(raw_documents):
    metadata = {}
    documents = {}
    for document_name in INPUTS:
        raw = raw_documents[document_name]
        document = json.loads(raw)
        rows = document["Items"]
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError("Invalid catalog length")
        documents[document_name] = rows
        metadata[document_name] = {
            "url": f"https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/{document_name}.json",
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    items = {}
    for row in documents["items"]:
        key = str(number(row["Id"], 1))
        if key in items:
            raise ValueError("Duplicate item")
        items[key] = {"name": name(row["Name"]), "weight": number(row["Weight"]),
                      "price": number(row["Price"]), "sellPrice": number(row["SellPrice"]),
                      "itemClass": number(row["ItemClass"], 1, 6), "useType": number(row["UseType"], 0, 2),
                      "position": number(row["Position"])}

    skills = {}
    for row in documents["skillinfo"]:
        key = str(number(row["SkillId"], 1, 255))
        if key in skills:
            raise ValueError("Duplicate skill")
        costs = row["SpCost"]
        if costs is not None and (not isinstance(costs, list) or len(costs) > 100):
            raise ValueError("Invalid skill costs")
        skills[key] = {"name": name(row["Name"] or f"Skill {key}"), "target": number(row["Target"], 0, 5),
                       "maxLevel": number(row["MaxLevel"], 0, 100),
                       "adjustableLevel": bool(row["AdjustableLevel"]),
                       "spCost": None if costs is None else [number(cost) for cost in costs]}

    trees = {}
    for row in documents["skilltree"]:
        key = str(number(row["ClassId"], 0, 255))
        if key in trees or len(row["Skills"]) > 255:
            raise ValueError("Invalid skill tree")
        trees[key] = {"extends": number(row["ExtendsClass"], -1, 255), "skills": [
            {"skillId": number(skill["Skill"], 1, 255), "requires": [
                {"skillId": number(p["Skill"], 1, 255), "level": number(p["Level"], 1, 100)}
                for p in skill["Prerequisites"]]} for skill in row["Skills"]]}

    result = {"build": "Build_2569-09-01-01-55", "sources": metadata,
              "items": items, "skills": skills, "trees": trees}
    return result


def main(argv=None):
    source, destination = map(Path, sys.argv[1:] if argv is None else argv)
    raw_documents = {name: (source / f"{name}.json").read_bytes() for name in INPUTS}
    result = build_catalog(raw_documents)
    write_catalog(destination, catalog_json(result, ensure_ascii=False))
    print(f"Built {len(result['items'])} items, {len(result['skills'])} skills and {len(result['trees'])} skill trees")


if __name__ == '__main__':
    main()
