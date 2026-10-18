"use strict";

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { withPkiLock, prepareClientCertificate } = require("../lib/pki-lock");

describe("pki-lock", function () {
  it("runs queued tasks one after another", async function () {
    const log = [];
    const task = (name, ms) => () =>
      new Promise((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });
    const results = await Promise.all([
      withPkiLock(task("a", 30)),
      withPkiLock(task("b", 5)),
    ]);
    expect(results).to.deep.equal(["a", "b"]);
    expect(log).to.deep.equal(["start a", "end a", "start b", "end b"]);
  });

  it("keeps going after a failed task", async function () {
    const failed = withPkiLock(() => Promise.reject(new Error("boom")));
    const next = withPkiLock(() => Promise.resolve("ok"));
    let err = null;
    try {
      await failed;
    } catch (e) {
      err = e;
    }
    expect(err && err.message).to.equal("boom");
    expect(await next).to.equal("ok");
  });

  it("prepareClientCertificate ignores clients without initializeCM", async function () {
    await prepareClientCertificate({});
    await prepareClientCertificate(null);
    let called = 0;
    await prepareClientCertificate({ initializeCM: async () => called++ });
    expect(called).to.equal(1);
  });

  it("two opcua-server nodes start together on a fresh default PKI", function (done) {
    this.timeout(60000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "opcua-pki-"));
    const base = 46000 + Math.floor(Math.random() * 1000);
    execFile(
      process.execPath,
      [
        path.join(__dirname, "fixtures", "two-servers-fresh-pki.js"),
        String(base),
        String(base + 1),
      ],
      {
        env: Object.assign({}, process.env, { XDG_CONFIG_HOME: home }),
        timeout: 55000,
      },
      (err, stdout) => {
        fs.rmSync(home, { recursive: true, force: true });
        if (err) return done(err);
        const line = stdout.trim().split("\n").pop();
        const result = JSON.parse(line);
        try {
          expect(result.errors, result.errors.join("\n")).to.deep.equal([]);
          expect(result.started).to.deep.equal([true, true]);
          done();
        } catch (e) {
          done(e);
        }
      },
    );
  });
});
