"use strict";

const { expect } = require("chai");
const EventEmitter = require("events");
const { BaseTransport } = require("../../lib/transports/base-transport");

describe("BaseTransport — abstract class contract", function () {

  it("constructor stores config object on this.config", function () {
    const t = new BaseTransport({ foo: 1 });
    expect(t.config).to.be.an("object");
    expect(t.config.foo).to.equal(1);
  });

  it("instance is an EventEmitter (instanceof check)", function () {
    const t = new BaseTransport({});
    expect(t instanceof EventEmitter).to.equal(true);
  });

  it("connect() rejects with 'not implemented'", async function () {
    const t = new BaseTransport({});
    let err;
    try {
      await t.connect();
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/not implemented/i);
  });

  it("close() rejects with 'not implemented'", async function () {
    const t = new BaseTransport({});
    let err;
    try {
      await t.close();
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/not implemented/i);
  });

  it("send() throws synchronously with 'not implemented'", function () {
    const t = new BaseTransport({});
    expect(function () {
      t.send(Buffer.alloc(0));
    }).to.throw(/not implemented/i);
  });

  it("exports BaseTransport as a named export", function () {
    const mod = require("../../lib/transports/base-transport");
    expect(mod.BaseTransport).to.equal(BaseTransport);
  });

  it("supports .on() / .emit() inherited from EventEmitter", function () {
    const t = new BaseTransport({});
    let received;
    t.on("foo", function (payload) {
      received = payload;
    });
    t.emit("foo", 42);
    expect(received).to.equal(42);
  });

});
