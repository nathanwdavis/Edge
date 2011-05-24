## Edge ##

Edge is a lightweight edge server for a CDN that runs on Node. It has no dependencies (other than Node) is quite simple to use:

     var edge = require('Edge');
     var edge_server = edge.createServer({host: 'nodejs.org'});


This simple configuration will reverse proxy, then cache all responses
keyed on the request URL.


Additional options:

     var edge_server = edge.createServer({host: 'nodejs.org', 
                                          port: 80,
                                          pathPrefix: '/docs/v0.4.7/api/assets',
                                          defaultMaxAge: 60*60*48 });


You can also just use directly from the command line (equivalent to
above:

     > node lib/edge-server.js nodejs.org 80 /docs/api/v0.4.7/api/assets 172800


Edge supports the following common features:

* Expires cached assets based on the Expires or Cache-Control headers of the origin request.
* Correctly uses client request headers to respond with 304 if possible
* Sets Cache-Control to a default if origin response doesn't have
  Cache-Control or Expires header
* Cookieless
* Simultaneous requests for the same cache missed asset will not result in multiple origin server requests. Each request will listen on the response of one single origin server request.

__More:__ For more info on CDNs, Node, and why I built this see these presentation slides: https://docs.google.com/present/view?id=dggt936r_21gg4kc7f6

__Note:__ This project has not been battle-tested. It is not production-ready.... yet.
