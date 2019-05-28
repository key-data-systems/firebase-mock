'use strict';

var _ = require('./lodash');
var assert = require('assert');
var Stream = require('stream');
var Promise = require('rsvp').Promise;
var autoId = require('firebase-auto-ids');
var QuerySnapshot = require('./firestore-query-snapshot');
var Queue = require('./queue').Queue;
var utils = require('./utils');
var validate = require('./validators');

function MockFirestoreQuery(path, data, parent, name, parentQuery) {
  this.errs = {};
  this.path = path || 'Mock://';
  this.id = parent ? name : extractName(path);
  this.flushDelay = parent ? parent.flushDelay : false;
  this.queue = parent ? parent.queue : new Queue();
  this.parent = parent || null;
  this.firestore = parent ? parent.firestore : null;
  this.children = {};
  this.orderedProperties = parentQuery ? _.clone(parentQuery.orderedProperties) : [];
  this.orderedDirections = parentQuery ? _.clone(parentQuery.orderedDirections) : [];
  this.limited = parentQuery ? parentQuery.limited : 0;
  this._setData(data);
}

MockFirestoreQuery.prototype.flush = function (delay) {
  this.queue.flush(delay);
  return this;
};

MockFirestoreQuery.prototype.autoFlush = function (delay) {
  if (_.isUndefined(delay)) {
    delay = true;
  }
  if (this.flushDelay !== delay) {
    this.flushDelay = delay;
    _.forEach(this.children, function (child) {
      child.autoFlush(delay);
    });
    if (this.parent) {
      this.parent.autoFlush(delay);
    }
  }
  return this;
};

MockFirestoreQuery.prototype.getFlushQueue = function () {
  return this.queue.getEvents();
};

MockFirestoreQuery.prototype._setData = function (data) {
  this.data = utils.cleanFirestoreData(_.cloneDeep(data) || null);
};

MockFirestoreQuery.prototype._getData = function () {
  return _.cloneDeep(this.data);
};

MockFirestoreQuery.prototype.toString = function () {
  return this.path;
};

MockFirestoreQuery.prototype.get = function () {
  var err = this._nextErr('get');
  var self = this;
  return new Promise(function (resolve, reject) {
    self._defer('get', _.toArray(arguments), function () {
      var _results = self._results();
      var results = _results.results;
      var keyOrder = _results.keyOrder;

      if (err === null) {
        if (_.size(self.data) !== 0) {
          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results, keyOrder));
        } else {
          resolve(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id)));
        }
      } else {
        reject(err);
      }
    });
  });
};

MockFirestoreQuery.prototype.stream = function () {
  var stream = new Stream();

  this.get().then(function (snapshots) {
    snapshots.forEach(function (snapshot) {
      stream.emit('data', snapshot);
    });
    stream.emit('end');
  });

  return stream;
};

MockFirestoreQuery.prototype.where = function (property, operator, value) {
  var query;

  // check if unsupported operator
  if (['==', 'array-contains'].indexOf(operator) === -1) {
    console.warn('Using unsupported where() operator for firebase-mock, returning entire dataset');
    return this;
  } else {
    if (_.size(this.data) !== 0) {
      var results = {};
      _.forEach(this.data, function(data, key) {
        switch (operator) {
          case '==':
            if (_.isEqual(_.get(data, property), value)) {
              results[key] = _.cloneDeep(data);
            }
            break;
          case  'array-contains':
            var dt = _.get(data, property);
            if (Array.isArray(dt) && dt.indexOf(value) > -1) {
              results[key] = _.cloneDeep(data);
            }
            break;
          default:
            results[key] = _.cloneDeep(data);
            break;
        }
      });
      return new MockFirestoreQuery(this.path, results, this.parent, this.id, this);
    } else {
      return new MockFirestoreQuery(this.path, null, this.parent, this.id, this);
    }
  }
};

MockFirestoreQuery.prototype.orderBy = function (property, direction) {
  var query = new MockFirestoreQuery(this.path, this._getData(), this.parent, this.id, this);
  query.orderedProperties.push(property);
  query.orderedDirections.push(direction || 'asc');

  return query;
};

MockFirestoreQuery.prototype.limit = function (limit) {
  var query = new MockFirestoreQuery(this.path, this._getData(), this.parent, this.id, this);
  query.limited = limit;
  return query;
};

MockFirestoreQuery.prototype.onSnapshot = function (optionsOrObserverOrOnNext, observerOrOnNextOrOnError, onErrorArg) {
  var err = this._nextErr('onSnapshot');
  var self = this;
  var onNext = optionsOrObserverOrOnNext;
  var onError = observerOrOnNextOrOnError;
  var includeMetadataChanges = optionsOrObserverOrOnNext.includeMetadataChanges;

  if (includeMetadataChanges) {
    // Note this doesn't truly mimic the firestore metadata changes behavior, however
    // since everything is syncronous, there isn't any difference in behavior.
    onNext = observerOrOnNextOrOnError;
    onError = onErrorArg;
  }
  var context = {
    data: {
      results: {}
    },
  };
  var onSnapshot = function () {
    // compare the current state to the one from when this function was created
    // and send the data to the callback if different.
    if (err === null) {
      self.get().then(function (querySnapshot) {
        var results = self._results();

        var added = {};
        var removed = {};
        var modified = {};

        _.forEach(results.results, function(nextValue, nextKey) {
            if(Object.keys(context.data.results || {}).indexOf(nextKey) === -1) {
              added[nextKey] = nextValue;
            } else if (!_.isEqual(context.data.results[nextKey], nextValue)) {
              modified[nextKey] = nextValue;
            }
        });

        _.forEach(context.data.results, function(value, key) {
          if (Object.keys(results.results).indexOf(key) === -1) {
            removed[key] = value;
          }
        });

        var hasAdditions = Object.keys(added).length > 0;
        var hasRemovals = Object.keys(removed).length > 0;
        var hasModififations = Object.keys(modified).length > 0;

        if (hasAdditions || hasRemovals || hasModififations || includeMetadataChanges) {
          onNext(new QuerySnapshot(self.parent === null ? self : self.parent.collection(self.id), results.results, results.keyOrder, {added, removed, modified}));
          // onNext(new QuerySnapshot(self.id, self.ref, results));
          context.data = results;
        }
      });
    } else {
      onError(err);
    }
  };

  // onSnapshot should always return when initially called, then
  // every time data changes.
  onSnapshot();
  var unsubscribe = this.queue.onPostFlush(onSnapshot);

  // return the unsubscribe function
  return unsubscribe;
};

MockFirestoreQuery.prototype._results = function () {
  var keyOrder = [];
  var results = _.cloneDeep(this.data) || {};
  _.forEach(results, function(data, key) {
    keyOrder.push(key);
  });


  if (_.size(this.data) === 0) {
    return results;
  }

  var ordered = [];
  _.forEach(this.data, function(data, key) {
    ordered.push({ data: data, key: key });
  });

  ordered = _.orderBy(ordered, _.map(this.orderedProperties, function(p) { return 'data.' + p; }), this.orderedDirections);

  keyOrder = [];
  _.forEach(ordered, function(item) {
    keyOrder.push(item.key);
  });

  if (this.limited > 0) {
    keyOrder = keyOrder.slice(0, this.limited);
  }

  return {results: results, keyOrder: keyOrder};
};

MockFirestoreQuery.prototype._defer = function (sourceMethod, sourceArgs, callback) {
  this.queue.push({
    fn: callback,
    context: this,
    sourceData: {
      ref: this,
      method: sourceMethod,
      args: sourceArgs
    }
  });
  if (this.flushDelay !== false) {
    this.flush(this.flushDelay);
  }
};

MockFirestoreQuery.prototype._nextErr = function (type) {
  var err = this.errs[type];
  delete this.errs[type];
  return err || null;
};

function extractName(path) {
  return ((path || '').match(/\/([^.$\[\]#\/]+)$/) || [null, null])[1];
}

module.exports = MockFirestoreQuery;
