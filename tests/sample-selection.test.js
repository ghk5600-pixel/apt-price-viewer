import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTargetComplexNames,
  selectCatalogTargets,
} from "../scripts/lib/sample-selection.mjs";

test("sample complex names select only exact normalized catalog names", () => {
  const names = parseTargetComplexNames(
    "더샵둔촌포레, 송파더플래티넘\n무악현대아파트"
  );
  const selection = selectCatalogTargets(
    [
      { complex_name: "더샵둔촌포레", kapt_code: "A1" },
      { complex_name: "송파더플래티넘", kapt_code: "A2" },
      { complex_name: "반포자이", kapt_code: "A3" },
    ],
    names
  );

  assert.deepEqual(
    selection.rows.map((row) => row.kapt_code),
    ["A1", "A2"]
  );
  assert.deepEqual(selection.missingNames, ["무악현대아파트"]);
});
