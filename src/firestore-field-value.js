"use strict";
var _ = require("./lodash");
function MockFirestoreFieldValue(type, data) {
  this.type = type;
  this.data = data;
}

function MockFirestoreArrayUnion(data) {
  this.data = data;
  this.type = "arrayUnion";

  this.arrayUnion = current => {
    if (!current || !Array.isArray(current)) {
      return this.data;
    } else {
      const d = this.data.filter(d => {
        return !current.some(c => _.isEqual(c, d));
      });
      return current.concat(d);
    }
  };
}

MockFirestoreFieldValue.prototype.isEqual = function(other) {
  if (other instanceof MockFirestoreFieldValue && this.type === other.type) {
    return true;
  }
  return false;
};

MockFirestoreFieldValue.arrayUnion = function(...elements) {
  console.log("elements:", elements);
  return new MockFirestoreArrayUnion(elements);
};

MockFirestoreFieldValue.delete = function() {
  return new MockFirestoreFieldValue("delete");
};

MockFirestoreFieldValue.serverTimestamp = function() {
  return new MockFirestoreFieldValue("serverTimestamp");
};

module.exports = MockFirestoreFieldValue;
