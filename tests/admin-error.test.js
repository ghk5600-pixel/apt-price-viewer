import test from "node:test";
import assert from "node:assert/strict";
import { SupplyAdminError, adminError } from "../functions/_shared/supply-admin.js";

test("관리자 오류를 실제 HTTP 상태 코드로 응답한다", async () => {
  const response = adminError(new SupplyAdminError("관리자 인증이 필요합니다.", 401));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "관리자 인증이 필요합니다." });
});
