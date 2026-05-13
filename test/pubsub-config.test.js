"use strict";

const { expect } = require("chai");

const {
  validateWriterGroup, WriterGroup,
  validateDataSetWriter, DataSetWriter,
  validatePublishedDataSet, PublishedDataSet,
  validateDataSetReader, DataSetReader,
} = require("../lib/pubsub-config");

describe("pubsub-config", function () {

  // ─── module exports ───

  describe("module exports", function () {
    it("exports 4 validators and 4 factories", function () {
      expect(validateWriterGroup).to.be.a("function");
      expect(WriterGroup).to.be.a("function");
      expect(validateDataSetWriter).to.be.a("function");
      expect(DataSetWriter).to.be.a("function");
      expect(validatePublishedDataSet).to.be.a("function");
      expect(PublishedDataSet).to.be.a("function");
      expect(validateDataSetReader).to.be.a("function");
      expect(DataSetReader).to.be.a("function");
    });
  });

  // ─── validateWriterGroup ───

  describe("validateWriterGroup (WGRP-01)", function () {
    it("returns valid for minimal valid input", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 1 });
      expect(r.valid).to.equal(true);
      expect(r.errors).to.deep.equal([]);
    });

    it("rejects non-object cfg", function () {
      const r = validateWriterGroup(null);
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_OBJECT");
    });

    it("rejects publishingInterval == 0 with MUST_BE_POSITIVE_NUMBER", function () {
      const r = validateWriterGroup({ publishingInterval: 0, writerGroupId: 1 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_POSITIVE_NUMBER");
      expect(r.errors[0].path).to.equal("publishingInterval");
    });

    it("rejects negative publishingInterval", function () {
      const r = validateWriterGroup({ publishingInterval: -10, writerGroupId: 1 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_POSITIVE_NUMBER");
    });

    it("rejects missing publishingInterval", function () {
      const r = validateWriterGroup({ writerGroupId: 1 });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.path === "publishingInterval"; })).to.equal(true);
    });

    // ROADMAP success criterion #3
    it("rejects keepAliveTime < publishingInterval with MUST_BE_GTE_PUBLISHING_INTERVAL", function () {
      const r = validateWriterGroup({ publishingInterval: 100, keepAliveTime: 50, writerGroupId: 1 });
      expect(r.valid).to.equal(false);
      expect(r.errors).to.have.length(1);
      expect(r.errors[0]).to.deep.include({
        path: "keepAliveTime",
        code: "MUST_BE_GTE_PUBLISHING_INTERVAL",
      });
    });

    it("accepts keepAliveTime == publishingInterval", function () {
      const r = validateWriterGroup({ publishingInterval: 100, keepAliveTime: 100, writerGroupId: 1 });
      expect(r.valid).to.equal(true);
    });

    it("accepts keepAliveTime > publishingInterval", function () {
      const r = validateWriterGroup({ publishingInterval: 100, keepAliveTime: 200, writerGroupId: 1 });
      expect(r.valid).to.equal(true);
    });

    it("rejects keepAliveTime == 0 with MUST_BE_POSITIVE_NUMBER", function () {
      const r = validateWriterGroup({ publishingInterval: 100, keepAliveTime: 0, writerGroupId: 1 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_POSITIVE_NUMBER");
      expect(r.errors[0].path).to.equal("keepAliveTime");
    });

    it("rejects priority > 255 with MUST_BE_BYTE_RANGE", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 1, priority: 256 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_BYTE_RANGE");
    });

    it("accepts priority == 0", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 1, priority: 0 });
      expect(r.valid).to.equal(true);
    });

    it("accepts priority == 255", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 1, priority: 255 });
      expect(r.valid).to.equal(true);
    });

    it("rejects writerGroupId == 0 with MUST_BE_NONZERO_UINT16", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 0 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_NONZERO_UINT16");
    });

    it("accepts writerGroupId == 65535 (max uint16)", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 65535 });
      expect(r.valid).to.equal(true);
    });

    it("rejects writerGroupId == 65536 (out of uint16 range)", function () {
      const r = validateWriterGroup({ publishingInterval: 100, writerGroupId: 65536 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_UINT16");
    });

    it("collects all errors (does not short-circuit)", function () {
      const r = validateWriterGroup({ publishingInterval: -1, writerGroupId: 0 });
      expect(r.valid).to.equal(false);
      expect(r.errors.length).to.be.gte(2);
    });
  });

  // ─── WriterGroup factory ───

  describe("WriterGroup factory", function () {
    it("throws on invalid input (factory cannot be bypassed)", function () {
      expect(function () {
        WriterGroup({ publishingInterval: 100, keepAliveTime: 50, writerGroupId: 1 });
      }).to.throw();
    });

    it("throws with a descriptive message containing the code or field name", function () {
      let err;
      try {
        WriterGroup({ publishingInterval: 100, keepAliveTime: 50, writerGroupId: 1 });
      } catch (e) {
        err = e;
      }
      expect(err).to.not.equal(undefined);
      expect(err.message).to.match(/MUST_BE_GTE_PUBLISHING_INTERVAL|keepAliveTime/);
    });

    it("applies defaults: keepAliveTime=publishingInterval, maxNetworkMessageSize=1400, priority=128", function () {
      const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1 });
      expect(wg.keepAliveTime).to.equal(100);
      expect(wg.maxNetworkMessageSize).to.equal(1400);
      expect(wg.priority).to.equal(128);
    });

    it("preserves explicit keepAliveTime when provided", function () {
      const wg = WriterGroup({ publishingInterval: 100, keepAliveTime: 200, writerGroupId: 1 });
      expect(wg.keepAliveTime).to.equal(200);
    });

    it("preserves explicit maxNetworkMessageSize", function () {
      const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1, maxNetworkMessageSize: 8000 });
      expect(wg.maxNetworkMessageSize).to.equal(8000);
    });

    it("preserves explicit priority", function () {
      const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1, priority: 0 });
      expect(wg.priority).to.equal(0);
    });

    it("freezes the returned config (Object.isFrozen === true)", function () {
      const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1 });
      expect(Object.isFrozen(wg)).to.equal(true);
    });
  });

  // ─── validatePublishedDataSet ───

  describe("validatePublishedDataSet", function () {
    it("returns valid for minimal valid input", function () {
      const r = validatePublishedDataSet({
        name: "DS1",
        fields: [{ name: "temp", dataType: "Double" }],
      });
      expect(r.valid).to.equal(true);
    });

    it("rejects missing name", function () {
      const r = validatePublishedDataSet({ fields: [{ name: "x", dataType: "Int32" }] });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.path === "name"; })).to.equal(true);
    });

    it("rejects empty name string", function () {
      const r = validatePublishedDataSet({
        name: "",
        fields: [{ name: "x", dataType: "Int32" }],
      });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_NON_EMPTY_STRING");
    });

    it("rejects empty fields array", function () {
      const r = validatePublishedDataSet({ name: "DS1", fields: [] });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_NON_EMPTY_ARRAY");
    });

    it("rejects missing fields array", function () {
      const r = validatePublishedDataSet({ name: "DS1" });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.path === "fields"; })).to.equal(true);
    });

    it("rejects field without dataType", function () {
      const r = validatePublishedDataSet({
        name: "DS1",
        fields: [{ name: "x" }],
      });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_STRING");
    });

    it("rejects invalid configurationVersion shape", function () {
      const r = validatePublishedDataSet({
        name: "DS1",
        fields: [{ name: "x", dataType: "Int32" }],
        configurationVersion: { major: "one", minor: 0 },
      });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_VERSION_PAIR");
    });

    it("accepts explicit valid configurationVersion", function () {
      const r = validatePublishedDataSet({
        name: "DS1",
        fields: [{ name: "x", dataType: "Int32" }],
        configurationVersion: { major: 2, minor: 3 },
      });
      expect(r.valid).to.equal(true);
    });
  });

  // ─── PublishedDataSet factory ───

  describe("PublishedDataSet factory", function () {
    it("defaults configurationVersion to { major: 1, minor: 0 }", function () {
      const pds = PublishedDataSet({
        name: "DS1",
        fields: [{ name: "x", dataType: "Int32" }],
      });
      expect(pds.configurationVersion).to.deep.equal({ major: 1, minor: 0 });
    });

    it("freezes the returned config (Object.isFrozen === true)", function () {
      const pds = PublishedDataSet({
        name: "DS1",
        fields: [{ name: "x", dataType: "Int32" }],
      });
      expect(Object.isFrozen(pds)).to.equal(true);
    });

    it("freezes the fields array", function () {
      const pds = PublishedDataSet({
        name: "DS1",
        fields: [{ name: "x", dataType: "Int32" }],
      });
      expect(Object.isFrozen(pds.fields)).to.equal(true);
    });

    it("throws on invalid input (factory cannot be bypassed)", function () {
      expect(function () { PublishedDataSet({ name: "DS1", fields: [] }); }).to.throw();
    });
  });

  // ─── validateDataSetWriter ───

  describe("validateDataSetWriter (DSW-01)", function () {
    it("returns valid for minimal valid input", function () {
      const r = validateDataSetWriter({ dataSetWriterId: 1 });
      expect(r.valid).to.equal(true);
    });

    it("rejects dataSetWriterId == 0", function () {
      const r = validateDataSetWriter({ dataSetWriterId: 0 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_NONZERO_UINT16");
    });

    it("rejects missing dataSetWriterId", function () {
      const r = validateDataSetWriter({});
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.path === "dataSetWriterId"; })).to.equal(true);
    });

    it("rejects negative keyFrameCount", function () {
      const r = validateDataSetWriter({ dataSetWriterId: 1, keyFrameCount: -1 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_NONNEGATIVE_INTEGER");
    });

    it("accepts keyFrameCount == 0 (all-delta frames)", function () {
      const r = validateDataSetWriter({ dataSetWriterId: 1, keyFrameCount: 0 });
      expect(r.valid).to.equal(true);
    });

    it("rejects non-integer dataSetName", function () {
      const r = validateDataSetWriter({ dataSetWriterId: 1, dataSetName: 42 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_STRING");
    });

    it("RawData mask rejects abstract NodeId field type", function () {
      const r = validateDataSetWriter({
        dataSetWriterId: 1,
        dataSetFieldContentMask: 0x20, // RawData bit (Part 14 §6.2.4 Table 32, bit 5)
        publishedDataSet: { name: "DS", fields: [{ name: "ref", dataType: "NodeId" }] },
      });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.code === "RAW_DATA_REQUIRES_CONCRETE_TYPES"; })).to.equal(true);
    });

    it("RawData mask rejects ExpandedNodeId field type", function () {
      const r = validateDataSetWriter({
        dataSetWriterId: 1,
        dataSetFieldContentMask: 0x20,
        publishedDataSet: { name: "DS", fields: [{ name: "exp", dataType: "ExpandedNodeId" }] },
      });
      expect(r.errors.some(function (e) { return e.code === "RAW_DATA_REQUIRES_CONCRETE_TYPES"; })).to.equal(true);
    });

    it("RawData mask rejects String field without maxStringLength", function () {
      const r = validateDataSetWriter({
        dataSetWriterId: 1,
        dataSetFieldContentMask: 0x20,
        publishedDataSet: { name: "DS", fields: [{ name: "label", dataType: "String" }] },
      });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.code === "RAW_DATA_STRING_MISSING_MAX_LENGTH"; })).to.equal(true);
    });

    it("RawData mask accepts String field WITH maxStringLength", function () {
      const r = validateDataSetWriter({
        dataSetWriterId: 1,
        dataSetFieldContentMask: 0x20,
        publishedDataSet: { name: "DS", fields: [{ name: "label", dataType: "String", maxStringLength: 64 }] },
      });
      expect(r.valid).to.equal(true);
    });

    it("no RawData mask set — String field without maxStringLength is accepted", function () {
      const r = validateDataSetWriter({
        dataSetWriterId: 1,
        publishedDataSet: { name: "DS", fields: [{ name: "label", dataType: "String" }] },
      });
      expect(r.valid).to.equal(true);
    });
  });

  // ─── DataSetWriter factory ───

  describe("DataSetWriter factory", function () {
    // ROADMAP success criterion #4 (part 1)
    it("defaults keyFrameCount to 1 (PITFALLS #3 mitigation)", function () {
      const dsw = DataSetWriter({ dataSetWriterId: 1 });
      expect(dsw.keyFrameCount).to.equal(1);
    });

    it("defaults dataSetFieldContentMask to 0 (Variant encoding)", function () {
      const dsw = DataSetWriter({ dataSetWriterId: 1 });
      expect(dsw.dataSetFieldContentMask).to.equal(0);
    });

    it("preserves explicit keyFrameCount", function () {
      const dsw = DataSetWriter({ dataSetWriterId: 1, keyFrameCount: 5 });
      expect(dsw.keyFrameCount).to.equal(5);
    });

    it("freezes the returned config", function () {
      const dsw = DataSetWriter({ dataSetWriterId: 1 });
      expect(Object.isFrozen(dsw)).to.equal(true);
    });

    it("throws on invalid input (factory cannot be bypassed)", function () {
      expect(function () { DataSetWriter({ dataSetWriterId: 0 }); }).to.throw();
    });

    it("embeds a frozen PublishedDataSet when provided", function () {
      const dsw = DataSetWriter({
        dataSetWriterId: 1,
        publishedDataSet: { name: "DS", fields: [{ name: "v", dataType: "Double" }] },
      });
      expect(dsw.publishedDataSet).to.not.equal(undefined);
      expect(Object.isFrozen(dsw.publishedDataSet)).to.equal(true);
    });
  });

  // ─── validateDataSetReader ───

  describe("validateDataSetReader (DSR-01)", function () {
    it("returns valid for publisherId-only filter", function () {
      const r = validateDataSetReader({ publisherId: "pub-1" });
      expect(r.valid).to.equal(true);
    });

    it("returns valid for writerGroupId-only filter", function () {
      const r = validateDataSetReader({ writerGroupId: 1 });
      expect(r.valid).to.equal(true);
    });

    it("returns valid for dataSetWriterId-only filter", function () {
      const r = validateDataSetReader({ dataSetWriterId: 1 });
      expect(r.valid).to.equal(true);
    });

    it("rejects empty filter (no publisherId/writerGroupId/dataSetWriterId) with FILTER_REQUIRED", function () {
      const r = validateDataSetReader({ keepAliveTime: 100 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("FILTER_REQUIRED");
    });

    it("rejects DataSetReader with no fields at all", function () {
      const r = validateDataSetReader({});
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.code === "FILTER_REQUIRED"; })).to.equal(true);
    });

    it("rejects negative keepAliveTime", function () {
      const r = validateDataSetReader({ publisherId: "p", keepAliveTime: -1 });
      expect(r.valid).to.equal(false);
      expect(r.errors[0].code).to.equal("MUST_BE_POSITIVE_NUMBER");
    });

    it("rejects zero messageReceiveTimeout", function () {
      const r = validateDataSetReader({ publisherId: "p", messageReceiveTimeout: 0 });
      expect(r.valid).to.equal(false);
      expect(r.errors.some(function (e) { return e.path === "messageReceiveTimeout"; })).to.equal(true);
    });
  });

  // ─── DataSetReader factory ───

  describe("DataSetReader factory", function () {
    // ROADMAP success criterion #4 (part 2) — both branches of the max() formula
    it("defaults messageReceiveTimeout to 5000 ms when keepAliveTime is small (5000 floor wins)", function () {
      const dsr = DataSetReader({ publisherId: "x", keepAliveTime: 100 });
      // 3 * 100 = 300 < 5000, floor wins
      expect(dsr.messageReceiveTimeout).to.equal(5000);
    });

    it("defaults messageReceiveTimeout to 3 × keepAliveTime when that exceeds 5000", function () {
      const dsr = DataSetReader({ publisherId: "x", keepAliveTime: 2000 });
      // 3 * 2000 = 6000 > 5000, multiplier wins
      expect(dsr.messageReceiveTimeout).to.equal(6000);
    });

    it("defaults messageReceiveTimeout to 5000 when no keepAliveTime is set", function () {
      const dsr = DataSetReader({ publisherId: "x" });
      expect(dsr.messageReceiveTimeout).to.equal(5000);
    });

    it("respects explicit messageReceiveTimeout (no override)", function () {
      const dsr = DataSetReader({ publisherId: "x", keepAliveTime: 100, messageReceiveTimeout: 12345 });
      expect(dsr.messageReceiveTimeout).to.equal(12345);
    });

    it("freezes the returned config", function () {
      const dsr = DataSetReader({ publisherId: "x" });
      expect(Object.isFrozen(dsr)).to.equal(true);
    });

    it("throws on missing filter (factory cannot be bypassed)", function () {
      expect(function () { DataSetReader({}); }).to.throw();
    });

    it("preserves publisherId on returned config", function () {
      const dsr = DataSetReader({ publisherId: "my-pub-42" });
      expect(dsr.publisherId).to.equal("my-pub-42");
    });

    it("preserves writerGroupId on returned config", function () {
      const dsr = DataSetReader({ writerGroupId: 7 });
      expect(dsr.writerGroupId).to.equal(7);
    });
  });
});
