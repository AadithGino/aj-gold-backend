const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { USER_ROLES } = require("../src/constants/enums");

function reloadBusinessRulesEnv(minAmount) {
  if (minAmount === undefined) {
    delete process.env.MIN_PAYMENT_AMOUNT;
  } else {
    process.env.MIN_PAYMENT_AMOUNT = String(minAmount);
  }
  delete require.cache[require.resolve("../src/config/env")];
  delete require.cache[require.resolve("../src/constants/businessRules")];
  delete require.cache[require.resolve("../src/routes/health.routes")];
  delete require.cache[require.resolve("../src/services/payment.service")];
}

describe("business rules and app-config", () => {
  it("getBusinessRules exposes minPaymentAmount from env", () => {
    reloadBusinessRulesEnv(750);
    const { getBusinessRules } = require("../src/constants/businessRules");
    assert.equal(getBusinessRules().minPaymentAmount, 750);
    reloadBusinessRulesEnv(undefined);
  });

  it("GET /api/health/app-config returns minPaymentAmount", async () => {
    reloadBusinessRulesEnv(500);
    const healthRoutes = require("../src/routes/health.routes");
    const app = express();
    app.use("/api/health", healthRoutes);

    const { status, body } = await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address();
        http.get(`http://127.0.0.1:${port}/api/health/app-config`, (res) => {
          let raw = "";
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(raw) });
            } catch (error) {
              reject(error);
            }
          });
        }).on("error", (error) => {
          server.close();
          reject(error);
        });
      });
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.minPaymentAmount, 500);
    reloadBusinessRulesEnv(undefined);
  });
});

describe("MIN_PAYMENT_AMOUNT validation", () => {
  it("rejects collection below configured minimum before DB work", async () => {
    reloadBusinessRulesEnv(500);
    const { collectPayment } = require("../src/services/payment.service");

    await assert.rejects(
      () =>
        collectPayment(
          {
            scheme: "000000000000000000000002",
            customer: "000000000000000000000001",
            amount: 499,
            paymentMethod: "CASH",
            clientRequestId: "00000000-0000-4000-8000-000000000099",
          },
          { _id: "000000000000000000000003", role: USER_ROLES.ADMIN }
        ),
      (error) => {
        assert.match(error.message, /at least ₹500/);
        assert.equal(error.statusCode, 400);
        return true;
      }
    );

    reloadBusinessRulesEnv(undefined);
  });
});
