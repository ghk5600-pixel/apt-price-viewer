export function parseTargetComplexNames(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function selectCatalogTargets(catalog, requestedNames) {
  if (!requestedNames.length) {
    return { rows: catalog, matchedNames: [], missingNames: [] };
  }

  const requestedByKey = new Map(
    requestedNames.map((name) => [normalizeComplexName(name), name])
  );
  const matchedKeys = new Set();
  const rows = catalog.filter((row) => {
    const key = normalizeComplexName(row.complex_name);
    if (!requestedByKey.has(key)) return false;
    matchedKeys.add(key);
    return true;
  });

  return {
    rows,
    matchedNames: [...matchedKeys].map((key) => requestedByKey.get(key)),
    missingNames: [...requestedByKey]
      .filter(([key]) => !matchedKeys.has(key))
      .map(([, name]) => name),
  };
}

function normalizeComplexName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, "");
}
