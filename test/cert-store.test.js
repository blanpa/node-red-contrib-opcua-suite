"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const fs = require("fs");
const os = require("os");
const path = require("path");

const certStore = require("../lib/cert-store");
const {
  sanitiseFilename,
  getCertsDir,
  listCerts,
  uploadCert,
  deleteCert,
  registerCertRoutes,
} = certStore;

const TMP_DIR = path.join(os.tmpdir(), "cert-store-test");

function makeMockRED(userDir) {
  const routes = {};
  const httpAdmin = {
    post: function (routePath, fn) { routes["POST " + routePath] = fn; },
    get: function (routePath, fn) { routes["GET " + routePath] = fn; },
    delete: function (routePath, fn) { routes["DEL " + routePath] = fn; },
  };
  const settings = { userDir: userDir || os.tmpdir() };
  return { httpAdmin, routes, settings };
}

function makeRes() {
  const res = {};
  res.json = sinon.stub().returns(res);
  res.status = sinon.stub().returns(res);
  return res;
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        rmrf(p);
      } else {
        fs.unlinkSync(p);
      }
    }
    fs.rmdirSync(dir);
  }
}

describe("cert-store", function () {

  before(function () {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }
  });

  after(function () {
    rmrf(TMP_DIR);
  });

  afterEach(function () {
    // Clean tmp dir contents but keep the dir itself
    if (fs.existsSync(TMP_DIR)) {
      for (const entry of fs.readdirSync(TMP_DIR)) {
        const p = path.join(TMP_DIR, entry);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          rmrf(p);
        } else {
          fs.unlinkSync(p);
        }
      }
    }
  });

  // ─── module exports ───

  describe("module exports", function () {
    it("exports the six required functions", function () {
      expect(sanitiseFilename).to.be.a("function");
      expect(getCertsDir).to.be.a("function");
      expect(listCerts).to.be.a("function");
      expect(uploadCert).to.be.a("function");
      expect(deleteCert).to.be.a("function");
      expect(registerCertRoutes).to.be.a("function");
    });
  });

  // ─── sanitiseFilename ───

  describe("sanitiseFilename", function () {
    it("replaces spaces with underscores", function () {
      expect(sanitiseFilename("my cert.pem")).to.equal("my_cert.pem");
    });

    it("replaces path-traversal characters", function () {
      expect(sanitiseFilename("../../evil")).to.equal(".._..evil");
    });

    it("preserves alphanumeric, dot, underscore, hyphen", function () {
      expect(sanitiseFilename("a-b_c.1.pem")).to.equal("a-b_c.1.pem");
    });

    it("replaces forward slashes", function () {
      expect(sanitiseFilename("foo/bar.pem")).to.equal("foo_bar.pem");
    });
  });

  // ─── getCertsDir ───

  describe("getCertsDir", function () {
    it("returns a path ending in 'opcua-certs'", function () {
      const RED = makeMockRED(TMP_DIR);
      const dir = getCertsDir(RED);
      expect(path.basename(dir)).to.equal("opcua-certs");
    });

    it("creates the directory if absent", function () {
      const subDir = path.join(TMP_DIR, "userdir-1");
      fs.mkdirSync(subDir);
      const RED = { settings: { userDir: subDir } };
      const dir = getCertsDir(RED);
      expect(fs.existsSync(dir)).to.equal(true);
    });

    it("falls back to '/data' when RED.settings.userDir is unset", function () {
      // Should not throw even if /data does not exist (try/catch swallows mkdir error)
      const RED = { settings: {} };
      const dir = getCertsDir(RED);
      expect(dir).to.equal(path.join("/data", "opcua-certs"));
    });
  });

  // ─── uploadCert ───

  describe("uploadCert", function () {
    it("writes the file and returns { path, bytes }", async function () {
      const content = Buffer.from("hello-cert").toString("base64");
      const result = await uploadCert(TMP_DIR, "test.pem", content);
      expect(result).to.have.property("path");
      expect(result).to.have.property("bytes");
      expect(fs.existsSync(result.path)).to.equal(true);
      expect(fs.readFileSync(result.path, "utf8")).to.equal("hello-cert");
      expect(result.bytes).to.equal("hello-cert".length);
    });

    it("rejects when base64Content is falsy", async function () {
      let caught = null;
      try {
        await uploadCert(TMP_DIR, "test.pem", "");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.not.equal(null);
      expect(caught.status).to.equal(400);
    });

    it("sanitises filename before writing", async function () {
      const content = Buffer.from("x").toString("base64");
      const result = await uploadCert(TMP_DIR, "../danger.pem", content);
      expect(path.basename(result.path)).to.equal(".._danger.pem");
    });
  });

  // ─── listCerts ───

  describe("listCerts", function () {
    it("returns array of filenames with allowed extensions only", async function () {
      fs.writeFileSync(path.join(TMP_DIR, "a.pem"), "x");
      fs.writeFileSync(path.join(TMP_DIR, "b.der"), "x");
      fs.writeFileSync(path.join(TMP_DIR, "c.txt"), "x");
      fs.writeFileSync(path.join(TMP_DIR, "d.crt"), "x");
      const list = await listCerts(TMP_DIR);
      expect(list).to.include("a.pem");
      expect(list).to.include("b.der");
      expect(list).to.include("d.crt");
      expect(list).to.not.include("c.txt");
    });

    it("returns empty array if directory does not exist", async function () {
      const ghostDir = path.join(TMP_DIR, "no-such-dir");
      const list = await listCerts(ghostDir);
      expect(list).to.deep.equal([]);
    });
  });

  // ─── deleteCert ───

  describe("deleteCert", function () {
    it("removes the file", async function () {
      const filePath = path.join(TMP_DIR, "to-delete.pem");
      fs.writeFileSync(filePath, "x");
      await deleteCert(TMP_DIR, "to-delete.pem");
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("rejects with status 404 when file does not exist", async function () {
      let caught = null;
      try {
        await deleteCert(TMP_DIR, "ghost.pem");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.not.equal(null);
      expect(caught.status).to.equal(404);
    });
  });

  // ─── registerCertRoutes ───

  describe("registerCertRoutes", function () {
    it("registers POST, GET, DELETE handlers exactly once each", function () {
      const RED = makeMockRED(TMP_DIR);
      const postSpy = sinon.spy(RED.httpAdmin, "post");
      const getSpy = sinon.spy(RED.httpAdmin, "get");
      const delSpy = sinon.spy(RED.httpAdmin, "delete");

      registerCertRoutes(RED, "/test-prefix", TMP_DIR);

      expect(postSpy.calledOnce).to.equal(true);
      expect(getSpy.calledOnce).to.equal(true);
      expect(delSpy.calledOnce).to.equal(true);
    });

    it("registers routes under the supplied prefix", function () {
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      expect(RED.routes).to.have.property("POST /test-prefix/upload-cert");
      expect(RED.routes).to.have.property("GET /test-prefix/certs");
      expect(RED.routes).to.have.property("DEL /test-prefix/upload-cert/:filename");
    });

    it("returns immediately when RED.httpAdmin is falsy", function () {
      const RED = { httpAdmin: null, settings: {} };
      // Must not throw
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
    });

    it("returns immediately when RED is falsy", function () {
      // Must not throw
      registerCertRoutes(null, "/test-prefix", TMP_DIR);
      registerCertRoutes(undefined, "/test-prefix", TMP_DIR);
    });

    it("POST handler writes a file from base64 content", async function () {
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      const handler = RED.routes["POST /test-prefix/upload-cert"];
      const content = Buffer.from("hello").toString("base64");
      const req = { body: { filename: "a.pem", content: content } };
      const res = makeRes();
      await handler(req, res);
      // success path calls res.json with object containing path
      expect(res.json.called).to.equal(true);
      const body = res.json.firstCall.args[0];
      expect(body).to.have.property("path");
      expect(fs.existsSync(body.path)).to.equal(true);
      expect(fs.readFileSync(body.path, "utf8")).to.equal("hello");
    });

    it("POST handler returns 400 when content field is missing", async function () {
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      const handler = RED.routes["POST /test-prefix/upload-cert"];
      const req = { body: { filename: "a.pem" } };
      const res = makeRes();
      await handler(req, res);
      expect(res.status.called).to.equal(true);
      expect(res.status.firstCall.args[0]).to.equal(400);
    });

    it("GET handler returns array of objects with name and path fields", async function () {
      fs.writeFileSync(path.join(TMP_DIR, "x.pem"), "x");
      fs.writeFileSync(path.join(TMP_DIR, "y.crt"), "y");
      fs.writeFileSync(path.join(TMP_DIR, "z.txt"), "z");
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      const handler = RED.routes["GET /test-prefix/certs"];
      const req = {};
      const res = makeRes();
      await handler(req, res);
      expect(res.json.called).to.equal(true);
      const body = res.json.firstCall.args[0];
      expect(body).to.be.an("array");
      const names = body.map(function (item) { return item.name; });
      expect(names).to.include("x.pem");
      expect(names).to.include("y.crt");
      expect(names).to.not.include("z.txt");
      // Each entry has path field
      body.forEach(function (item) {
        expect(item).to.have.property("path");
      });
    });

    it("DELETE handler removes the file", async function () {
      const target = path.join(TMP_DIR, "kill-me.pem");
      fs.writeFileSync(target, "x");
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      const handler = RED.routes["DEL /test-prefix/upload-cert/:filename"];
      const req = { params: { filename: "kill-me.pem" } };
      const res = makeRes();
      await handler(req, res);
      expect(fs.existsSync(target)).to.equal(false);
      expect(res.json.called).to.equal(true);
    });

    it("DELETE handler returns 404 when file is absent", async function () {
      const RED = makeMockRED(TMP_DIR);
      registerCertRoutes(RED, "/test-prefix", TMP_DIR);
      const handler = RED.routes["DEL /test-prefix/upload-cert/:filename"];
      const req = { params: { filename: "ghost.pem" } };
      const res = makeRes();
      await handler(req, res);
      expect(res.status.called).to.equal(true);
      expect(res.status.firstCall.args[0]).to.equal(404);
    });
  });
});
