import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
const { createCloudSecureFormFixture, fieldIds } = await import(
  new URL("../scripts/fixtures/secure-form-cloud.mjs", import.meta.url).href
);

test("cloud fixture confirms exact field hashes, rejects foreign origins and returns value-free evidence", async () => {
  const values = Object.fromEntries(
    fieldIds.map((id: string) => [id, randomUUID()]),
  );
  const hashes = Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  const origin = "https://fixture.test";
  const server = createCloudSecureFormFixture({ hashes, origin });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path: string, body: string, from = origin) =>
      fetch(url + path, {
        method: "POST",
        headers: { origin: from },
        body,
        redirect: "manual",
      });
    assert.equal(
      (
        await post(
          "/observe",
          JSON.stringify({ id: "name", value: values.name }),
          "https://foreign.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/confirm",
          new URLSearchParams({ ...values, name: "wrong" }).toString(),
        )
      ).status,
      400,
    );
    await post("/observe", JSON.stringify({ id: "name", value: "wrong" }));
    for (const id of fieldIds)
      await post("/observe", JSON.stringify({ id, value: values[id] }));
    const before = await (await fetch(url + "/status")).json();
    assert.deepEqual(before, {
      matchedFieldIds: fieldIds,
      events: 8,
      confirmations: 0,
    });
    const submit = await post(
      "/confirm",
      new URLSearchParams(values).toString(),
    );
    assert.equal(submit.status, 303);
    assert.ok(submit.headers.get("location")!.includes(values.name));
    const after = await (await fetch(url + "/status")).json();
    assert.equal(after.confirmations, 1);
    for (const v of [...Object.values(values), ...Object.values(hashes)])
      assert.ok(!JSON.stringify(after).includes(v));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(r));
  }
});
