#!/usr/bin/env node
/**
 * Smoke test new customer-facing HTTP endpoints against a running server.
 * Usage: node scripts/smokeCustomerApis.js [baseUrl]
 */
const base = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");

const phone = `7${String(Date.now()).slice(-9)}`;
const password = "password12";

async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  const results = [];

  const register = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Smoke Test", phone, password, address: "Addr" }),
  });
  results.push(["POST /api/auth/register", register.status, register.body?.success]);
  if (!register.body?.data?.token) {
    console.error("Register failed:", register);
    process.exit(1);
  }
  const token = register.body.data.token;

  const me = await request("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  results.push(["GET /api/auth/me", me.status, me.body?.success]);

  const getDel = await request("/api/profile/deletion-request", {
    headers: { Authorization: `Bearer ${token}` },
  });
  results.push(["GET /api/profile/deletion-request", getDel.status, getDel.body?.success]);

  const createDel = await request("/api/profile/deletion-request", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason: "smoke test" }),
  });
  results.push(["POST /api/profile/deletion-request", createDel.status, createDel.body?.success]);

  const cancelDel = await request("/api/profile/deletion-request/cancel", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  results.push(["POST /api/profile/deletion-request/cancel", cancelDel.status, cancelDel.body?.success]);

  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  results.push(["POST /api/auth/logout", logout.status, logout.body?.success]);

  const meAfterLogout = await request("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  results.push(["GET /api/auth/me after logout (expect 401)", meAfterLogout.status, meAfterLogout.status === 401]);

  console.log("Customer API smoke results:");
  for (const [name, status, ok] of results) {
    console.log(`  ${ok ? "✓" : "✗"} ${name} → ${status}`);
  }

  const failed = results.some(([, , ok]) => !ok);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
