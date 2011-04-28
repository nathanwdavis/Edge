var ENDING, NOT_SENT, QueuedRequest, RECEIVING_RESP, ResponseCacheValue, SENT, buildCacheValueFromMasterResponse, createServer, defaultContentType, defaultMaxAge, events, exports, fileCache, http, log, masterEndPointOpts, masterReqQueue, path, respondFromMasterResponse, tryRespondFromCache, util, writeResponseFromCachedFile;
var __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };
http = require('http');
path = require('path');
util = require('util');
events = require('events');
log = util.log;
defaultContentType = 'text/plain';
defaultMaxAge = 60 * 60 * 48;
exports = module.exports;
/*

  hashtable of local files keyed on path
*/
exports.fileCache = fileCache = {};
masterReqQueue = {};
NOT_SENT = 1;
SENT = 2;
RECEIVING_RESP = 3;
ENDING = 4;
QueuedRequest = function() {
  this.status = NOT_SENT;
  return events.EventEmitter.call(this);
};
util.inherits(QueuedRequest, events.EventEmitter);
QueuedRequest.prototype.setStatus = function(status) {
  this.status = status;
  return this.emit('status', status);
};
QueuedRequest.prototype.setRequest = function(req) {
  this.request = req;
  this.status = SENT;
  req.on('response', __bind(function(resp) {
    this.status = RECEIVING_RESP;
    this.emit('receiving', resp);
    return resp.on('end', __bind(function() {
      return this.status = ENDING;
    }, this));
  }, this));
  return this.emit('sent', req);
};
QueuedRequest.prototype.end = function(respValue) {
  return this.emit('end', respValue);
};
ResponseCacheValue = function() {
  this.createDate = Date.now();
  return events.EventEmitter.call(this);
};
util.inherits(ResponseCacheValue, events.EventEmitter);
ResponseCacheValue.prototype.setHead = function(statusCode, headers) {
  var expires, expiresVal, match;
  this.statusCode = statusCode;
  this.headers = headers;
  if (this.headers.connection) {
    delete headers.connection;
  }
  if (!this.headers['cache-control']) {
    if (expiresVal = this.headers['expires']) {
      expires = Date.parse(expiresVal);
      this.ttl = expires - this.createDate;
      this.headers['cache-control'] = "public, max-age=" + (this.ttl / 1000);
    } else {
      this.ttl = defaultMaxAge * 1000;
      this.headers['cache-control'] = "public, max-age=" + defaultMaxAge;
    }
  } else {
    match = this.headers['cache-control'].match(/max-age=(\d+)/i);
    if ((match != null) && typeof match === 'object' && match.length > 1) {
      this.ttl = parseInt(match[1]) * 1000;
    } else {
      this.ttl = defaultMaxAge * 1000;
    }
  }
  if (!this.headers['last-modified']) {
    return this.headers['last-modified'] = (new Date()).toUTCString();
  }
};
ResponseCacheValue.prototype.addChunk = function(chunk) {
  if (!this.chunks) {
    this.chunks = [];
  }
  return this.chunks.push(chunk);
};
ResponseCacheValue.prototype.setComplete = function() {
  return this.emit('complete');
};
/*

  Example:
  var edge = require('edge');
  var edge_server = edge.createServer({
    host: 'yoursite.com',
    port: 80, //defaults to 80
    pathPrefix: '/static', //defaults to '/'
    defaultMaxAge: 60*60*48 //set caching timeout to 48 hours
                            //if it can't be inferred from
                            //origin server request
  });

*/
exports.createServer = createServer = function(masterEndPoint) {
  masterEndPoint.port || (masterEndPoint.port = 80);
  masterEndPoint.pathPrefix || (masterEndPoint.pathPrefix = '/');
  if (masterEndPoint.defaultMaxAge) {
    defaultMaxAge = masterEndPoint.defaultMaxAge;
  }
  http.createServer(function(req, resp) {
    var masterReqOpts, proxReq, queuedReq;
    log("\n" + req.method + " " + req.url + " :");
    log(JSON.stringify(req.headers));
    if (tryRespondFromCache(req, resp)) {
      /* cache hit */
      return;
    }
    /*
      cache miss
      Need to retrieve from master

    */
    /*
       Is this is one already waiting on a respone
    */
    if (queuedReq = masterReqQueue[req.url]) {
      switch (queuedReq.status) {
        case NOT_SENT:
          queuedReq.on('sent', __bind(function(proxReq) {
            return proxReq.on('response', __bind(function(proxResp) {
              return respondFromMasterResponse(resp, proxResp);
            }, this));
          }, this));
          log('cache miss, but NOT_SENT request already in queue');
          break;
        case SENT:
          queuedReq.on('receiving', function(proxResp) {
            return respondFromMasterResponse(resp, proxResp);
          });
          log('cache miss, but already SENT from previous request');
          break;
        case RECEIVING_RESP:
        case ENDING:
          queuedReq.on('end', function(respValue) {
            return writeResponseFromCachedFile(resp, respValue);
          });
          log('cache miss, but RECEIVING_RESP from previous request');
      }
    } else {
      log('cache miss, queuing request');
      queuedReq = new QueuedRequest();
      masterReqQueue[req.url] = queuedReq;
      masterReqOpts = {
        host: masterEndPoint.host,
        port: masterEndPoint.port,
        path: path.join(masterEndPoint.pathPrefix, req.url),
        headers: req.headers
      };
      proxReq = http.get(masterReqOpts, function(proxResp) {
        var cacheValue;
        respondFromMasterResponse(resp, proxResp);
        cacheValue = buildCacheValueFromMasterResponse(proxResp);
        cacheValue.on('complete', function() {
          fileCache[req.url] = cacheValue;
          queuedReq.end(cacheValue);
          return delete masterReqQueue[req.url];
        });
      });
      queuedReq.setRequest(proxReq);
      proxReq.on('error', function(err) {
        log("Error: Could not GET " + masterReqOpts.path + "\n" + (JSON.stringify(err)));
        resp.writeHead(500, {
          'Content-Type': defaultContentType
        });
        resp.end('An error occurred.');
        return err;
      });
    }
  }).listen(8099);
  return log('Server created on 8099');
};
writeResponseFromCachedFile = function(resp, file) {
  var chunk, chunkCount, _i, _len, _ref;
  log("cache hit, " + file.statusCode);
  resp.writeHead(file.statusCode, file.headers);
  log("headers written, " + file.headers);
  chunkCount = 0;
  _ref = file.chunks;
  for (_i = 0, _len = _ref.length; _i < _len; _i++) {
    chunk = _ref[_i];
    resp.write(chunk);
    log("chunk " + (chunkCount++) + " written");
  }
  resp.end();
  log("response ended\n\n");
  return true;
};
tryRespondFromCache = function(req, resp) {
  var dateToCompare, expires, file, lastModified, now;
  file = fileCache[req.url];
  if (typeof file === 'object') {
    if (req.headers['if-modified-since']) {
      debugger;
      dateToCompare = Date.parse(req.headers['if-modified-since']);
      lastModified = Date.parse(file.headers['last-modified']);
      if (lastModified > 0 && dateToCompare > 0 && lastModified <= dateToCompare) {
        log('cache hit, 304');
        resp.writeHead(304, file.headers);
        resp.end();
        return true;
      }
    }
    now = Date.now();
    expires = file.createDate + file.ttl;
    if (now > expires) {
      delete fileCache[req.url];
      return false;
    }
    return writeResponseFromCachedFile(resp, file);
  } else {
    return false;
  }
};
respondFromMasterResponse = function(resp, masterResp) {
  resp.setMaxListeners(200);
  delete masterResp.headers.connection;
  resp.writeHead(masterResp.statusCode, masterResp.headers);
  masterResp.on('data', function(data) {
    return resp.write(data);
  });
  masterResp.on('end', function() {
    return resp.end();
  });
};
buildCacheValueFromMasterResponse = function(masterResp) {
  var cacheValue;
  cacheValue = new ResponseCacheValue();
  cacheValue.setHead(masterResp.statusCode, masterResp.headers);
  masterResp.on('data', function(data) {
    return cacheValue.addChunk(data);
  });
  masterResp.on('end', function() {
    return cacheValue.setComplete();
  });
  return cacheValue;
};
/*

  if this js file is called directly with node with at least one
  extra argument (the host), then we can just call createServer
  Example:
    > node edge_server.js localhost 9000

*/
if (process.argv[1] === __filename && process.argv.length > 2) {
  masterEndPointOpts = {
    host: process.argv[2]
  };
  if (process.argv.length === 4) {
    masterEndPointOpts.port = parseInt(process.argv[3]);
  }
  if (process.argv.length === 5) {
    masterEndPointOpts.pathPrefix = process.argv[4];
  }
  if (process.argv.length === 6) {
    masterEndPointOpts.defaultMaxAge = process.argv[5];
  }
  createServer(masterEndPointOpts);
}