## Edge ##

Edge is a lightweight edge server for a CDN that runs on Node. It is quite simple to use:

     var edge = require('Edge');
     var edge_server = edge.createServer({host: 'nodejs.org'});

This simple configuration will reverse proxy, then cache all responses
keyed on the request URL.

Edge supports the following advanced features:

* Expires cached assets based on the Expires or Cache-Control headers of the origin request.
* Correctly uses client request headers to respond with 304 if possible
* Simultaneous requests for the same cache missed asset will not result in multiple origin server requests. Each request will listen on the response of one single origin server request.

