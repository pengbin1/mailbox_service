import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { CLIENT, PAGE, STYLE } from "../src/ui.js";

test("customer page has a valid client script and required controls", () => {
  assert.doesNotThrow(() => new Script(CLIENT));
  for (const id of ["login-form", "address", "password", "message-list", "message-body", "download", "refresh", "logout"]) {
    assert.match(PAGE, new RegExp(`id="${id}"`));
  }
  assert.match(STYLE, /@media\(max-width:700px\)/);
});
