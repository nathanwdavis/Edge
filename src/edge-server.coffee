http = require 'http'
path = require 'path'
util = require 'util'
events = require 'events'

log = util.log

defaultContentType = 'text/plain'
defaultMaxAge = 60*60*48

exports = module.exports

###

  hashtable of local files keyed on path
###
exports.fileCache = fileCache = {}

# queue of current requests to origin server
masterReqQueue = {}
NOT_SENT       = 1
SENT           = 2
RECEIVING_RESP = 3
ENDING         = 4
QueuedRequest = () ->
  @status = NOT_SENT
  events.EventEmitter.call(this)
util.inherits(QueuedRequest, events.EventEmitter)

QueuedRequest::setStatus = (status) ->
  @status = status
  @emit('status', status)

QueuedRequest::setRequest = (req) ->
  @request = req
  @status = SENT
  req.on('response', (resp) =>
    @status = RECEIVING_RESP
    @emit('receiving', resp)
    resp.on('end', =>
      @status = ENDING
    )
  )
  @emit('sent', req)

QueuedRequest::end = (respValue) ->
  @emit('end', respValue)


ResponseCacheValue = () ->
  @createDate = Date.now()
  events.EventEmitter.call(this)
util.inherits(ResponseCacheValue, events.EventEmitter)

ResponseCacheValue::setHead = (statusCode, headers) ->
  @statusCode = statusCode
  @headers = headers
  # don't cache a Connection header
  if @headers.connection
    delete @headers.connection

  # set a default cache-control if there isn't one
  # and set a @ttl attribute (milliseconds)
  if not @headers['cache-control']
    if expiresVal = @headers['expires']
      expires = Date.parse(expiresVal)
      @ttl = expires - @createDate
      @headers['cache-control'] = "public, max-age=#{@ttl / 1000}"
    else
      @ttl = defaultMaxAge * 1000
      @headers['cache-control'] = "public, max-age=#{defaultMaxAge}"
  else
    match = @headers['cache-control'].match(/max-age=(\d+)/i)
    if match? and typeof match == 'object' and match.length > 1
      @ttl = parseInt(match[1]) * 1000
    else
      @ttl = defaultMaxAge * 1000

  # set a last-modified if there isn't one
  if not @headers['last-modified']
    @headers['last-modified'] = (new Date()).toUTCString()

ResponseCacheValue::addChunk = (chunk) ->
  if not @chunks
    @chunks = []
  @chunks.push chunk

ResponseCacheValue::setComplete = ->
  @emit('complete')

###

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

###
exports.createServer = createServer = (masterEndPoint) ->

  masterEndPoint.port or= 80
  masterEndPoint.pathPrefix or= '/'
  if masterEndPoint.defaultMaxAge
    defaultMaxAge = masterEndPoint.defaultMaxAge

  http.createServer( (req, resp) ->
    log "\n#{req.method} #{req.url} :"
    log JSON.stringify req.headers

    if tryRespondFromCache(req, resp)
      ### cache hit ###
      return
    # else fall through to cache miss routine

    ###
      cache miss
      Need to retrieve from master

    ###
    ###
       Is this one already waiting on a respone
    ###
    if queuedReq = masterReqQueue[req.url]
      #hook into events here
      switch queuedReq.status
        when NOT_SENT
          queuedReq.on('sent', (proxReq) =>
            proxReq.on('response', (proxResp) =>
              respondFromMasterResponse(resp, proxResp)
            )
          )
          log 'cache miss, but NOT_SENT request already in queue'
        when SENT
          queuedReq.on('receiving', (proxResp) ->
            respondFromMasterResponse(resp, proxResp)
          )
          log 'cache miss, but already SENT from previous request'
        when RECEIVING_RESP, ENDING
          queuedReq.on('end', (respValue) ->
            writeResponseFromCachedFile(resp, respValue)
          )
          log 'cache miss, but RECEIVING_RESP from previous request'
    else

      log 'cache miss, queuing request'
      queuedReq = new QueuedRequest()
      masterReqQueue[req.url] = queuedReq

      masterReqOpts = {
        host: masterEndPoint.host,
        port: masterEndPoint.port,
        path: path.join(masterEndPoint.pathPrefix, req.url),
        headers: req.headers
      }

      proxReq = http.get(masterReqOpts, (proxResp) ->
        cacheValue = buildCacheValueFromMasterResponse(proxResp)
        proxResp.headers = cacheValue.headers
        respondFromMasterResponse(resp, proxResp)
        cacheValue.on('complete', ->
          fileCache[req.url] = cacheValue
          queuedReq.end(cacheValue)
          delete masterReqQueue[req.url]
        )
        return
      )
      queuedReq.setRequest proxReq

      proxReq.on('error', (err) ->
        log """Error: Could not GET #{masterReqOpts.path}
               #{JSON.stringify err}"""
        resp.writeHead(500, {'Content-Type': defaultContentType})
        resp.end 'An error occurred.'
        err
      )

    return
  )
  .listen 8099

  log 'Server created on 8099'

writeResponseFromCachedFile = (resp, file) ->
  log "cache hit, #{file.statusCode}"
  resp.writeHead(file.statusCode, file.headers)
  log "headers written, #{file.headers}"
  chunkCount = 0
  for chunk in file.chunks
    resp.write chunk
    log "chunk #{chunkCount++} written"

  resp.end()
  log "response ended\n\n"
  return yes


tryRespondFromCache = (req, resp) ->

  file = fileCache[req.url]
  if typeof file == 'object'

    if req.headers['if-modified-since']
      debugger
      dateToCompare = Date.parse(req.headers['if-modified-since'])
      lastModified = Date.parse(file.headers['last-modified'])
      if (lastModified > 0 and dateToCompare > 0 and
          lastModified <= dateToCompare)
        log 'cache hit, 304'
        resp.writeHead(304, file.headers)
        resp.end()
        return yes

    now = Date.now()
    expires = file.createDate + file.ttl
    if now > expires
      delete fileCache[req.url]
      return no

    return writeResponseFromCachedFile(resp, file)

  else
    return no


respondFromMasterResponse = (resp, masterResp) ->
  resp.setMaxListeners(200)
  delete masterResp.headers.connection
  resp.writeHead(masterResp.statusCode, masterResp.headers)
  masterResp.on('data', (data) ->
    resp.write data
  )

  masterResp.on('end',  ->
    resp.end()
  )
  return

buildCacheValueFromMasterResponse = (masterResp) ->
  cacheValue = new ResponseCacheValue()
  cacheValue.setHead(masterResp.statusCode, masterResp.headers)

  masterResp.on('data', (data) ->
    cacheValue.addChunk(data)
  )

  masterResp.on('end', ->
    cacheValue.setComplete()
  )
  cacheValue

###

  if this js file is called directly with node with at least one
  extra argument (the host), then we can just call createServer
  Example:
    > node edge_server.js localhost 9000

###
if (process.argv[1] == __filename and process.argv.length > 2)
  masterEndPointOpts = {
    host: process.argv[2]
  }
  if process.argv.length == 4
    masterEndPointOpts.port = parseInt(process.argv[3])
  if process.argv.length == 5
    masterEndPointOpts.pathPrefix = process.argv[4]
  if process.argv.length == 6
    masterEndPointOpts.defaultMaxAge = process.argv[5]
  createServer(masterEndPointOpts)



