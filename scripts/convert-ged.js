#!/usr/bin/env node
/**
 * convert-ged.js — Parse a GEDCOM 5.5.1 file and output family-chart JSON.
 *
 * Usage: node scripts/convert-ged.js
 * Input:  data/poppenhusen.ged
 * Output: data/family-data.json
 */

const fs = require("fs");
const path = require("path");

const GED_PATH = path.join(__dirname, "..", "data", "poppenhusen.ged");
const OUT_PATH = path.join(__dirname, "..", "data", "family-data.json");

// ── Parse GEDCOM into structured records ──────────────────────────────────────

function parseGedcom(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const records = []; // top-level records
  let stack = [];     // nesting stack

  for (const raw of lines) {
    const match = raw.match(/^(\d+)\s+(@\w+@\s+)?(.+)/);
    if (!match) continue;

    const level = parseInt(match[1], 10);
    const xref = match[2] ? match[2].trim() : null;
    let rest = match[3];

    // Split tag from value
    const spaceIdx = rest.indexOf(" ");
    let tag, value;
    if (spaceIdx === -1) {
      tag = rest;
      value = "";
    } else {
      tag = rest.substring(0, spaceIdx);
      value = rest.substring(spaceIdx + 1);
    }

    const node = { level, xref, tag, value, children: [] };

    if (level === 0) {
      records.push(node);
      stack = [node];
    } else {
      // Pop stack to find parent at level - 1
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
  }

  return records;
}

// ── Helper: find child node by tag ────────────────────────────────────────────

function findChild(node, tag) {
  return node.children.find((c) => c.tag === tag);
}

function findChildren(node, tag) {
  return node.children.filter((c) => c.tag === tag);
}

function getChildValue(node, tag) {
  const child = findChild(node, tag);
  return child ? child.value : "";
}

// Collect CONT/CONC lines into a single string
function getFullText(node) {
  let text = node.value;
  for (const child of node.children) {
    if (child.tag === "CONT") text += "\n" + child.value;
    else if (child.tag === "CONC") text += child.value;
  }
  return text;
}

// ── Extract individuals ───────────────────────────────────────────────────────

function parseIndividual(record) {
  const id = record.xref; // e.g. @I001@

  // Name
  const nameNode = findChild(record, "NAME");
  let firstName = "", lastName = "";
  if (nameNode) {
    const givn = findChild(nameNode, "GIVN");
    const surn = findChild(nameNode, "SURN");
    firstName = givn ? givn.value : "";
    lastName = surn ? surn.value : "";
    // Fallback: parse from NAME value "First /Last/"
    if (!firstName && !lastName) {
      const m = nameNode.value.match(/^(.+?)\s*\/(.+?)\//);
      if (m) { firstName = m[1]; lastName = m[2]; }
    }
  }

  // Gender
  const sex = getChildValue(record, "SEX"); // M or F

  // Birth
  const birthNode = findChild(record, "BIRT");
  let birthday = "";
  if (birthNode) {
    birthday = getChildValue(birthNode, "DATE");
  }

  // Death
  const deathNode = findChild(record, "DEAT");
  let deathday = "";
  if (deathNode) {
    deathday = getChildValue(deathNode, "DATE");
  }

  // Occupation
  const occupation = getChildValue(record, "OCCU");

  // Notes — collect all NOTE tags
  const noteNodes = findChildren(record, "NOTE");
  const notes = noteNodes.map((n) => getFullText(n)).join(" ");

  // Custom _REPORT tag
  const report = getChildValue(record, "_REPORT");

  // Family links (FAMS = spouse-in, FAMC = child-in)
  const fams = findChildren(record, "FAMS").map((c) => c.value);
  const famc = findChildren(record, "FAMC").map((c) => c.value);

  return {
    id,
    firstName,
    lastName,
    gender: sex === "M" ? "M" : "F",
    birthday,
    deathday,
    occupation,
    notes,
    report,
    fams,
    famc,
  };
}

// ── Extract families ──────────────────────────────────────────────────────────

function parseFamily(record) {
  const id = record.xref;
  const husb = getChildValue(record, "HUSB");
  const wife = getChildValue(record, "WIFE");
  const children = findChildren(record, "CHIL").map((c) => c.value);

  const marrNode = findChild(record, "MARR");
  let marriageDate = "";
  if (marrNode) {
    marriageDate = getChildValue(marrNode, "DATE");
  }

  return { id, husb, wife, children, marriageDate };
}

// ── Build family-chart data ───────────────────────────────────────────────────

function buildFamilyChartData(individuals, families) {
  // Build relationship maps from family records
  const personRels = {}; // id -> { parents: [], spouses: [], children: [] }

  for (const ind of individuals) {
    personRels[ind.id] = { parents: [], spouses: [], children: [] };
  }

  for (const fam of families) {
    const { husb, wife, children } = fam;

    // Spouses
    if (husb && wife) {
      if (personRels[husb]) personRels[husb].spouses.push(wife);
      if (personRels[wife]) personRels[wife].spouses.push(husb);
    }

    // Children → parents
    for (const childId of children) {
      if (personRels[childId]) {
        if (husb) personRels[childId].parents.push(husb);
        if (wife) personRels[childId].parents.push(wife);
      }
      // Parents → children
      if (husb && personRels[husb]) personRels[husb].children.push(childId);
      if (wife && personRels[wife]) personRels[wife].children.push(childId);
    }
  }

  // Deduplicate (a person can be FAMS in multiple families, e.g. Juergen Wilhelm)
  for (const id of Object.keys(personRels)) {
    personRels[id].spouses = [...new Set(personRels[id].spouses)];
    personRels[id].children = [...new Set(personRels[id].children)];
    personRels[id].parents = [...new Set(personRels[id].parents)];
  }

  // Build output array
  return individuals.map((ind) => ({
    id: ind.id,
    data: {
      "first name": ind.firstName,
      "last name": ind.lastName,
      gender: ind.gender,
      birthday: ind.birthday,
      deathday: ind.deathday,
      occupation: ind.occupation,
      report: ind.report,
    },
    rels: personRels[ind.id] || { parents: [], spouses: [], children: [] },
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const gedText = fs.readFileSync(GED_PATH, "utf-8");
const records = parseGedcom(gedText);

const individuals = records
  .filter((r) => r.tag === "INDI")
  .map(parseIndividual);

const families = records
  .filter((r) => r.tag === "FAM")
  .map(parseFamily);

console.log(`Parsed ${individuals.length} individuals, ${families.length} families`);

const chartData = buildFamilyChartData(individuals, families);

fs.writeFileSync(OUT_PATH, JSON.stringify(chartData, null, 2));
console.log(`Wrote ${OUT_PATH}`);
