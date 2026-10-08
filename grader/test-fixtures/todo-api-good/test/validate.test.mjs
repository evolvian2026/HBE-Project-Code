import assert from "node:assert/strict";
import { test } from "node:test";
import { validTitle } from "../validate.mjs";

test("accepts a normal title", () => assert.equal(validTitle("Buy milk"), true));
test("rejects an empty title", () => assert.equal(validTitle(""), false));
