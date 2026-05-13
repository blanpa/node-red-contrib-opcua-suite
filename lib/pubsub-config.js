/**
 * PubSub Configuration Objects
 *
 * Pure validators and frozen-object factories for OPC UA PubSub
 * configuration: WriterGroup, DataSetWriter, PublishedDataSet, DataSetReader.
 *
 * Hybrid pattern (D-13): each type exports both
 *   validate*(cfg) -> { valid: boolean, errors: Issue[] }
 *   Type(cfg)      -> Readonly<TypeConfig> ; throws createError on invalid
 *
 * Issue shape (D-14): { path, code, message }
 *
 * Exports:
 *   validateWriterGroup(cfg)      -> { valid: boolean, errors: Issue[] }
 *   WriterGroup(cfg)              -> Readonly<WriterGroupConfig>
 *   validateDataSetWriter(cfg)    -> { valid: boolean, errors: Issue[] }
 *   DataSetWriter(cfg)            -> Readonly<DataSetWriterConfig>
 *   validatePublishedDataSet(cfg) -> { valid: boolean, errors: Issue[] }
 *   PublishedDataSet(cfg)         -> Readonly<PublishedDataSetConfig>
 *   validateDataSetReader(cfg)    -> { valid: boolean, errors: Issue[] }
 *   DataSetReader(cfg)            -> Readonly<DataSetReaderConfig>
 */

"use strict";

const { createError } = require("./opcua-utils");

// ─── Constants ───

const DEFAULT_MAX_NETWORK_MESSAGE_SIZE = 1400;          // PITFALLS #6 - IPv4 UDP MTU-safe
const DEFAULT_PRIORITY                  = 128;          // Part 14 §6.2.6 default
const DEFAULT_KEY_FRAME_COUNT           = 1;            // PITFALLS #3 - no delta cold-start
const DEFAULT_PUBLISHED_DS_VERSION      = { major: 1, minor: 0 };
const DEFAULT_RECEIVE_TIMEOUT_MIN_MS    = 5000;         // PITFALLS #3 floor
const DEFAULT_RECEIVE_TIMEOUT_FACTOR    = 3;            // PITFALLS #3 multiplier
const FIELD_CONTENT_MASK_RAWDATA_BIT    = 0x20;         // Part 14 §6.2.4 Table 32 (bit 5)
const ABSTRACT_TYPES_FOR_RAWDATA        = new Set(["NodeId", "ExpandedNodeId", "DiagnosticInfo"]);

// ─── Helpers ───

function _isPositiveNumber(v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }
function _isNonNegativeInt(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0; }
function _isUInt16(v) { return Number.isInteger(v) && v >= 0 && v <= 0xFFFF; }
function _issue(path, code, message) { return { path, code, message }; }

// ─── WriterGroup (WGRP-01) ───

/**
 * Validates a WriterGroup configuration.
 * Collects all errors — does NOT short-circuit on first error.
 *
 * @param {object} cfg - WriterGroup configuration object
 * @returns {{ valid: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
function validateWriterGroup(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    return { valid: false, errors: [_issue("", "MUST_BE_OBJECT", "cfg must be an object")] };
  }
  // publishingInterval: REQUIRED, number > 0
  if (!_isPositiveNumber(cfg.publishingInterval)) {
    errors.push(_issue("publishingInterval", "MUST_BE_POSITIVE_NUMBER",
      "publishingInterval must be a number > 0"));
  }
  // keepAliveTime: optional, must be >= publishingInterval (Part 14 §6.2.5)
  if (cfg.keepAliveTime !== undefined) {
    if (!_isPositiveNumber(cfg.keepAliveTime)) {
      errors.push(_issue("keepAliveTime", "MUST_BE_POSITIVE_NUMBER",
        "keepAliveTime must be a number > 0"));
    } else if (_isPositiveNumber(cfg.publishingInterval) && cfg.keepAliveTime < cfg.publishingInterval) {
      errors.push(_issue("keepAliveTime", "MUST_BE_GTE_PUBLISHING_INTERVAL",
        `keepAliveTime (${cfg.keepAliveTime}) must be >= publishingInterval (${cfg.publishingInterval})`));
    }
  }
  // maxNetworkMessageSize: optional, must be > 0
  if (cfg.maxNetworkMessageSize !== undefined && !_isPositiveNumber(cfg.maxNetworkMessageSize)) {
    errors.push(_issue("maxNetworkMessageSize", "MUST_BE_POSITIVE_NUMBER",
      "maxNetworkMessageSize must be > 0"));
  }
  // priority: optional, integer 0-255
  if (cfg.priority !== undefined &&
      (!Number.isInteger(cfg.priority) || cfg.priority < 0 || cfg.priority > 255)) {
    errors.push(_issue("priority", "MUST_BE_BYTE_RANGE", "priority must be integer 0..255"));
  }
  // writerGroupId: REQUIRED, integer 1-65535
  if (!_isUInt16(cfg.writerGroupId)) {
    errors.push(_issue("writerGroupId", "MUST_BE_UINT16",
      "writerGroupId must be integer 0..65535"));
  } else if (cfg.writerGroupId === 0) {
    errors.push(_issue("writerGroupId", "MUST_BE_NONZERO_UINT16",
      "writerGroupId must be 1..65535 (0 reserved)"));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a frozen WriterGroup config. Throws createError on invalid input.
 * Applies defaults: keepAliveTime=publishingInterval, maxNetworkMessageSize=1400, priority=128.
 *
 * @param {object} cfg - WriterGroup configuration object
 * @returns {Readonly<WriterGroupConfig>}
 */
function WriterGroup(cfg) {
  const { valid, errors } = validateWriterGroup(cfg);
  if (!valid) {
    const err = createError(`WriterGroup invalid: ${errors[0].message}`);
    err.code = errors[0].code;
    err.errors = errors;
    throw err;
  }
  return Object.freeze({
    publishingInterval:    cfg.publishingInterval,
    keepAliveTime:         cfg.keepAliveTime ?? cfg.publishingInterval,
    maxNetworkMessageSize: cfg.maxNetworkMessageSize ?? DEFAULT_MAX_NETWORK_MESSAGE_SIZE,
    priority:              cfg.priority ?? DEFAULT_PRIORITY,
    writerGroupId:         cfg.writerGroupId,
  });
}

// ─── PublishedDataSet (part of DSW-01) ───

/**
 * Validates a PublishedDataSet configuration.
 * Collects all errors — does NOT short-circuit on first error.
 *
 * @param {object} cfg - PublishedDataSet configuration object
 * @returns {{ valid: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
function validatePublishedDataSet(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    return { valid: false, errors: [_issue("", "MUST_BE_OBJECT", "cfg must be an object")] };
  }
  // name: REQUIRED non-empty string
  if (typeof cfg.name !== "string" || cfg.name.length === 0) {
    errors.push(_issue("name", "MUST_BE_NON_EMPTY_STRING", "name must be a non-empty string"));
  }
  // fields: REQUIRED non-empty array of { name, dataType, valueRank?, maxStringLength? }
  if (!Array.isArray(cfg.fields) || cfg.fields.length === 0) {
    errors.push(_issue("fields", "MUST_BE_NON_EMPTY_ARRAY", "fields must be a non-empty array"));
  } else {
    cfg.fields.forEach(function (f, i) {
      if (!f || typeof f !== "object") {
        errors.push(_issue(`fields[${i}]`, "MUST_BE_OBJECT", "field must be an object"));
        return;
      }
      if (typeof f.name !== "string" || f.name.length === 0) {
        errors.push(_issue(`fields[${i}].name`, "MUST_BE_NON_EMPTY_STRING", "field.name required"));
      }
      if (typeof f.dataType !== "string") {
        errors.push(_issue(`fields[${i}].dataType`, "MUST_BE_STRING", "field.dataType required as string"));
      }
    });
  }
  // configurationVersion: optional { major: UInt32, minor: UInt32 }
  if (cfg.configurationVersion !== undefined) {
    const cv = cfg.configurationVersion;
    if (!cv || typeof cv !== "object" ||
        !Number.isInteger(cv.major) || !Number.isInteger(cv.minor)) {
      errors.push(_issue("configurationVersion", "MUST_BE_VERSION_PAIR",
        "configurationVersion must be { major: int, minor: int }"));
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a frozen PublishedDataSet config. Throws createError on invalid input.
 * Defaults configurationVersion to { major: 1, minor: 0 }.
 *
 * @param {object} cfg - PublishedDataSet configuration object
 * @returns {Readonly<PublishedDataSetConfig>}
 */
function PublishedDataSet(cfg) {
  const { valid, errors } = validatePublishedDataSet(cfg);
  if (!valid) {
    const err = createError(`PublishedDataSet invalid: ${errors[0].message}`);
    err.code = errors[0].code;
    err.errors = errors;
    throw err;
  }
  return Object.freeze({
    name:                 cfg.name,
    fields:               Object.freeze(cfg.fields.map(function (f) { return Object.freeze({ ...f }); })),
    configurationVersion: Object.freeze(cfg.configurationVersion ?? { ...DEFAULT_PUBLISHED_DS_VERSION }),
  });
}

// ─── DataSetWriter (DSW-01) ───

/**
 * Validates a DataSetWriter configuration.
 * Includes RawData cross-validation (PITFALLS #2 / D-15):
 * when dataSetFieldContentMask bit 5 (0x20) is set, validates
 * that publishedDataSet fields use concrete types and String fields
 * declare maxStringLength.
 *
 * @param {object} cfg - DataSetWriter configuration object
 * @returns {{ valid: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
function validateDataSetWriter(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    return { valid: false, errors: [_issue("", "MUST_BE_OBJECT", "cfg must be an object")] };
  }
  // dataSetWriterId: REQUIRED, integer 1-65535
  if (!_isUInt16(cfg.dataSetWriterId) || cfg.dataSetWriterId === 0) {
    errors.push(_issue("dataSetWriterId", "MUST_BE_NONZERO_UINT16",
      "dataSetWriterId must be 1..65535"));
  }
  // dataSetName: optional string
  if (cfg.dataSetName !== undefined && typeof cfg.dataSetName !== "string") {
    errors.push(_issue("dataSetName", "MUST_BE_STRING", "dataSetName must be a string"));
  }
  // keyFrameCount: optional integer >= 0
  if (cfg.keyFrameCount !== undefined && !_isNonNegativeInt(cfg.keyFrameCount)) {
    errors.push(_issue("keyFrameCount", "MUST_BE_NONNEGATIVE_INTEGER",
      "keyFrameCount must be a non-negative integer"));
  }
  // dataSetFieldContentMask: optional integer (bit mask)
  if (cfg.dataSetFieldContentMask !== undefined && !Number.isInteger(cfg.dataSetFieldContentMask)) {
    errors.push(_issue("dataSetFieldContentMask", "MUST_BE_INTEGER",
      "dataSetFieldContentMask must be an integer (bitmask)"));
  }

  // RawData cross-validation (PITFALLS #2 / D-15 / Part 14 §6.2.4 Table 32, bit 5)
  const mask = cfg.dataSetFieldContentMask ?? 0;
  if (mask & FIELD_CONTENT_MASK_RAWDATA_BIT) {
    if (!cfg.publishedDataSet || !Array.isArray(cfg.publishedDataSet.fields)) {
      errors.push(_issue("publishedDataSet", "RAW_DATA_REQUIRES_PUBLISHED_DS",
        "RawData encoding requires publishedDataSet on the writer for cross-validation"));
    } else {
      cfg.publishedDataSet.fields.forEach(function (f, i) {
        if (ABSTRACT_TYPES_FOR_RAWDATA.has(f.dataType)) {
          errors.push(_issue(`publishedDataSet.fields[${i}].dataType`,
            "RAW_DATA_REQUIRES_CONCRETE_TYPES",
            `RawData encoding rejects abstract type '${f.dataType}' on field '${f.name}'`));
        }
        if (f.dataType === "String" &&
            (f.maxStringLength === undefined || !_isNonNegativeInt(f.maxStringLength))) {
          errors.push(_issue(`publishedDataSet.fields[${i}].maxStringLength`,
            "RAW_DATA_STRING_MISSING_MAX_LENGTH",
            `RawData encoding requires maxStringLength on String field '${f.name}'`));
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a frozen DataSetWriter config. Throws createError on invalid input.
 * Defaults: keyFrameCount=1 (PITFALLS #3), dataSetFieldContentMask=0 (Variant).
 *
 * @param {object} cfg - DataSetWriter configuration object
 * @returns {Readonly<DataSetWriterConfig>}
 */
function DataSetWriter(cfg) {
  const { valid, errors } = validateDataSetWriter(cfg);
  if (!valid) {
    const err = createError(`DataSetWriter invalid: ${errors[0].message}`);
    err.code = errors[0].code;
    err.errors = errors;
    throw err;
  }
  return Object.freeze({
    dataSetWriterId:         cfg.dataSetWriterId,
    dataSetName:             cfg.dataSetName,
    keyFrameCount:           cfg.keyFrameCount ?? DEFAULT_KEY_FRAME_COUNT,
    dataSetFieldContentMask: cfg.dataSetFieldContentMask ?? 0,
    publishedDataSet:        cfg.publishedDataSet ? PublishedDataSet(cfg.publishedDataSet) : undefined,
  });
}

// ─── DataSetReader (DSR-01) ───

/**
 * Validates a DataSetReader configuration.
 * Requires at least one filter: publisherId | writerGroupId | dataSetWriterId (D-15, PITFALLS #3).
 *
 * @param {object} cfg - DataSetReader configuration object
 * @returns {{ valid: boolean, errors: Array<{path: string, code: string, message: string}> }}
 */
function validateDataSetReader(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    return { valid: false, errors: [_issue("", "MUST_BE_OBJECT", "cfg must be an object")] };
  }
  // Filter: at least one of publisherId | writerGroupId | dataSetWriterId REQUIRED (T-02-19)
  const hasFilter = cfg.publisherId !== undefined ||
                    cfg.writerGroupId !== undefined ||
                    cfg.dataSetWriterId !== undefined;
  if (!hasFilter) {
    errors.push(_issue("", "FILTER_REQUIRED",
      "DataSetReader requires at least one of publisherId, writerGroupId, dataSetWriterId"));
  }
  // keepAliveTime: optional, must be > 0
  if (cfg.keepAliveTime !== undefined && !_isPositiveNumber(cfg.keepAliveTime)) {
    errors.push(_issue("keepAliveTime", "MUST_BE_POSITIVE_NUMBER",
      "keepAliveTime must be > 0"));
  }
  // messageReceiveTimeout: optional, must be > 0
  if (cfg.messageReceiveTimeout !== undefined && !_isPositiveNumber(cfg.messageReceiveTimeout)) {
    errors.push(_issue("messageReceiveTimeout", "MUST_BE_POSITIVE_NUMBER",
      "messageReceiveTimeout must be > 0"));
  }
  // dataSetFieldContentMask: optional integer (bit mask)
  if (cfg.dataSetFieldContentMask !== undefined && !Number.isInteger(cfg.dataSetFieldContentMask)) {
    errors.push(_issue("dataSetFieldContentMask", "MUST_BE_INTEGER",
      "dataSetFieldContentMask must be integer bitmask"));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Creates a frozen DataSetReader config. Throws createError on invalid input.
 * Defaults messageReceiveTimeout = max(3 × keepAliveTime, 5000) ms (PITFALLS #3, RESEARCH.md A2).
 *
 * @param {object} cfg - DataSetReader configuration object
 * @returns {Readonly<DataSetReaderConfig>}
 */
function DataSetReader(cfg) {
  const { valid, errors } = validateDataSetReader(cfg);
  if (!valid) {
    const err = createError(`DataSetReader invalid: ${errors[0].message}`);
    err.code = errors[0].code;
    err.errors = errors;
    throw err;
  }
  // Default messageReceiveTimeout = max(3 × keepAliveTime, 5000) — PITFALLS #3, RESEARCH.md A2
  const keepAlive = _isPositiveNumber(cfg.keepAliveTime) ? cfg.keepAliveTime : 0;
  const defaultTimeout = Math.max(DEFAULT_RECEIVE_TIMEOUT_FACTOR * keepAlive, DEFAULT_RECEIVE_TIMEOUT_MIN_MS);
  return Object.freeze({
    publisherId:             cfg.publisherId,
    writerGroupId:           cfg.writerGroupId,
    dataSetWriterId:         cfg.dataSetWriterId,
    keepAliveTime:           cfg.keepAliveTime,
    messageReceiveTimeout:   cfg.messageReceiveTimeout ?? defaultTimeout,
    dataSetFieldContentMask: cfg.dataSetFieldContentMask ?? 0,
  });
}

// ─── Exports ───

module.exports = {
  validateWriterGroup,
  WriterGroup,
  validateDataSetWriter,
  DataSetWriter,
  validatePublishedDataSet,
  PublishedDataSet,
  validateDataSetReader,
  DataSetReader,
};
