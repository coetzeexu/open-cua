import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CUAService, PendingUserChannel } from "@cua/service";
import { startHttpGateway } from "@cua/mcp";
import {
  FakeBrowserProvider,
  fakeCapabilities,
  fakeResolver,
} from "@cua/testing";

for (const failAt of [undefined, 2]) {
  test(`real service and HTTP MCP secure form ${failAt ? "partial recovery" : "complete delivery"} with fake browser`, async () => {
    const provider = new FakeBrowserProvider();
    const channel = new PendingUserChannel();
    const capabilities = fakeCapabilities();
    const bind = capabilities.action!.bind.bind(capabilities.action);
    let deliveries = 0;
    const privateError = `provider-private-${randomUUID()}`;
    capabilities.action!.bind = async (context) => {
      const action = await bind(context);
      return {
        ...action,
        deliverSecureForm: async (kind, target, value, ctx) => {
          deliveries++;
          if (deliveries === failAt) throw Error(privateError);
          return action.deliverSecureForm!(kind, target, value, ctx);
        },
      };
    };
    const service = new CUAService({
      profiles: {
        fake: () => ({
          browser: provider,
          capabilities,
          targetResolvers: [fakeResolver],
        }),
      },
      userChannel: channel,
      executeWaitMs: 0,
      terminationGraceMs: 20,
    });
    const token = "c".repeat(64);
    const gateway = await startHttpGateway(service, {
      token,
      port: 0,
      apps: true,
    });
    const client = new Client({ name: "secure-integration", version: "1" }, {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    } as any);
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}/mcp`,
      ),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const modelResults: unknown[] = [];
    async function call(
      name: string,
      args: Record<string, unknown>,
      model = true,
    ): Promise<any> {
      const result = await client.callTool({ name, arguments: args });
      if (model)
        modelResults.push({
          content: result.content,
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      return result;
    }
    async function poll(sessionId: string, executionId: string) {
      let result: any;
      const deadline = Date.now() + 6000;
      do {
        result = (
          await call("cua_poll", { sessionId, executionId, waitMs: 100 })
        ).structuredContent;
        if (Date.now() > deadline)
          throw Error("Integration execution did not settle");
      } while (result.status === "running");
      return result;
    }
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      for (const name of [
        "cua_ui_secure_form_state",
        "cua_ui_secure_form_answer",
      ])
        assert.deepEqual(
          (tools.find((tool) => tool.name === name)!._meta as any).ui
            .visibility,
          ["app"],
        );
      const resource = await client.readResource({
        uri: "ui://cua/secure-form.html",
      });
      assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
      assert.ok(
        !String((resource.contents[0] as any).text).includes("__APP_SCRIPT__"),
      );
      const sessionId = (await call("cua_session_create", { profile: "fake" }))
        .structuredContent.sessionId;
      const boot = (
        await call("cua_exec", {
          sessionId,
          code: 'var browser=await cua.connect();var tab=await browser.tabs.create({url:"https://fixture.test/passenger"});',
        })
      ).structuredContent;
      assert.equal(
        (await poll(sessionId, boot.executionId)).status,
        "succeeded",
      );
      const page = provider.connection.pages[0];
      const nativeOption = `native-private-${randomUUID()}`;
      const optionLabel = `option-label-private-${randomUUID()}`;
      page.secureForms.set("#name", {
        nodeId: "node-name",
        bindingRevision: "name-v1",
        control: "text",
        required: true,
        nonEmpty: false,
      });
      page.secureForms.set("#date", {
        nodeId: "node-date",
        bindingRevision: "date-v1",
        control: "date",
        required: true,
        nonEmpty: false,
        min: "1900-01-01",
      });
      page.secureForms.set("#country", {
        nodeId: "node-country",
        bindingRevision: "country-v1",
        control: "select",
        required: true,
        nonEmpty: false,
        options: [{ value: nativeOption, label: optionLabel }],
      });
      const execution = (
        await call("cua_exec", {
          sessionId,
          code: 'var secureResult=await tab.secureForm.request({title:"Passenger 1",groups:[{id:"passenger",label:"Passenger 1"}],fields:[{id:"name",label:"Name",groupId:"passenger",control:"text",target:tab.locator("#name")},{id:"date",label:"Birth date",control:"date",target:tab.locator("#date")},{id:"country",label:"Country",control:"select",target:tab.locator("#country")}],delivery:{mode:"fill"}});output.json({...secureResult,status:"forged-worker-status",extra:"worker-extra-must-not-escape"});',
        })
      ).structuredContent;
      assert.equal(execution.status, "running");
      let pending: any;
      const deadline = Date.now() + 6000;
      while (!pending) {
        pending = service
          .humanRequests(sessionId)
          .find((request) => request.type === "secure_form");
        if (Date.now() > deadline) throw Error("Secure form request missing");
        if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const requestId = pending.id;
      const opened = await call("cua_secure_form", { sessionId, requestId });
      assert.equal(opened.isError, undefined);
      const view = opened._meta.cua;
      assert.equal(view.executionId, execution.executionId);
      const values = {
        name: `name-private-${randomUUID()}`,
        date: "1992-03-04",
        country: view.request.fields.find(
          (field: any) => field.id === "country",
        ).options[0].id,
      };
      const access = { sessionId, requestId, token: view.token };
      const answer = {
        ...access,
        action: "submit",
        submissionId: randomUUID(),
        schemaRevision: view.request.schemaRevision,
        values,
      };
      const accepted = await call("cua_ui_secure_form_answer", answer, false);
      assert.equal(accepted.isError, undefined);
      assert.ok(
        ["accepted", "delivering", "filled"].includes(
          accepted._meta.cua.status,
        ),
      );
      await call("cua_ui_secure_form_answer", answer, false);
      const result = await poll(sessionId, execution.executionId);
      assert.equal(result.executionId, execution.executionId);
      assert.equal(result.status, "succeeded");
      const receipt = JSON.parse(
        result.output.find((item: any) => item.type === "json").text,
      );
      const expectedStatus = failAt ? "partial_or_unknown" : "filled";
      assert.equal(receipt.status, expectedStatus);
      assert.equal(receipt.requestId, requestId);
      assert.equal(receipt.executionId, execution.executionId);
      assert.equal(receipt.nextAction, "human_review");
      assert.equal(receipt.request, undefined);
      assert.equal(receipt.values, undefined);
      assert.equal(receipt.extra, undefined);
      assert.equal(page.filled.get("#name"), values.name);
      if (failAt) {
        assert.equal(page.filled.get("#date"), undefined);
        assert.equal(page.filled.get("#country"), undefined);
        assert.deepEqual(receipt.confirmedFieldIds, ["name"]);
        assert.deepEqual(receipt.uncertainFieldIds, ["date"]);
      } else {
        assert.equal(page.filled.get("#date"), values.date);
        assert.equal(page.filled.get("#country"), nativeOption);
        assert.deepEqual(receipt.confirmedFieldIds, [
          "name",
          "date",
          "country",
        ]);
      }
      assert.equal(deliveries, failAt ?? 3);
      const reopened = await call("cua_secure_form", { sessionId, requestId });
      assert.equal(reopened._meta.cua.status, expectedStatus);
      assert.equal(reopened._meta.cua.request, undefined);
      assert.notEqual(reopened._meta.cua.token, view.token);
      const continuation = reopened._meta.cua.continuation;
      assert.match(
        continuation.content[0].text,
        new RegExp(execution.executionId),
      );
      const resumed = await call(
        "cua_ui_secure_form_state",
        { sessionId, requestId, token: reopened._meta.cua.token },
        false,
      );
      assert.equal(resumed._meta.cua.executionId, execution.executionId);
      await call(
        "cua_ui_secure_form_answer",
        { ...answer, token: reopened._meta.cua.token },
        false,
      );
      assert.equal(
        deliveries,
        failAt ?? 3,
        "reopening and duplicate private answer never dispatch again",
      );
      const after = (
        await call("cua_exec", {
          sessionId,
          code: "output.json(await tab.secureForm.status(secureResult.requestId));",
        })
      ).structuredContent;
      const checked = await poll(sessionId, after.executionId);
      assert.equal(JSON.parse(checked.output[0].text).status, expectedStatus);
      for (const secret of [
        values.name,
        values.date,
        nativeOption,
        optionLabel,
        privateError,
        view.token,
        reopened._meta.cua.token,
        "worker-extra-must-not-escape",
        "forged-worker-status",
      ]) {
        assert.ok(!JSON.stringify(modelResults).includes(secret));
        assert.ok(!JSON.stringify(continuation).includes(secret));
      }
    } finally {
      await client.close();
      await gateway.close();
      await service.close();
    }
  });
}
