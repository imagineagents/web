/*
REWRITE INFO:
https://github.com/tinganho/connect-modrewrite
*/
var fs = require('fs');
var es = require('event-stream');
var url = require('url');
var querystring = require('querystring');
var modRewrite = require('connect-modrewrite');
var toobusy = require('toobusy-js');
var _ = require('underscore');

var config = require(__dirname + '/../../../config');
var help = require(__dirname + '/../help');
var log = require(__dirname + '/../log');

var Datasource = require(__dirname + '/../datasource');

var Router = function (server, options) {

  this.data = {};
  this.params = {};
  this.constraints = {};
  this.options = options;
  this.handlers = null;
  this.rules = [];

  this.rewritesFile = config.get('rewrites.path');
  this.rewritesDatasource = config.get('rewrites.datasource');

  this.server = server;

  var self = this;

  // load the route constraint specifications if they exist
  try {
    delete require.cache[options.routesPath + '/constraints.js'];
    this.handlers = require(options.routesPath + '/constraints.js');
  }
  catch (err) {
    log.info('[ROUTER] No route constraints loaded, file not found (' + options.routesPath + '/constraints.js' + ')');
  }

  // load the rewrites from the filesystem
  if (this.rewritesFile && this.rewritesFile !== '') {
    this.loadRewrites(options, function(err) {
      if (!err) self.loadRewriteModule();
    });
  }
}

Router.prototype.loadRewrites = function(options, done) {
  
  var rules = [];
  var self = this;  
  
  self.rules = [];
  
  var stream = fs.createReadStream(self.rewritesFile, {encoding: 'utf8'});

  stream.pipe(es.split("\n"))
        .pipe(es.mapSync(function (data) {
          if (data !== "") rules.push(data);
        })
  );

  stream.on('error', function (err) {
    log.error('[ROUTER] No rewrites loaded, file not found (' + self.rewritesFile + ')');
    done(err);
  });

  stream.on('end', function() {
    self.rules = rules.slice(0);
    done(null);
  });

}

/**
 *  Attaches a function from /workspace/routes/constraints.js or a datasource to the specified route
 *  @param {String} route
 *  @param {String} fn
 *  @return undefined
 *  @api public
 */
Router.prototype.constrain = function(route, constraint) {
  
  var self = this;
  var c;
  var message;

  if (this.handlers[constraint]) {

    // add constraint from /workspace/routes/constraints.js if it exists
    c = this.handlers[constraint];
    message = "[ROUTER] Added route constraint function '%s' for '%s'";
  }
  else {

    // try to build a datasource from the provided constraint
    var datasource = new Datasource(route, constraint, this.options, function(err, ds) {
      if (err) {
        log.error(err);
      }

      c = ds;
      message = "[ROUTER] Added route constraint datasource '%s' for '%s'";
    });
  }

  if (c) {
    this.constraints[route] = c;
    log.info(message, constraint, route);
  }
  else {
    log.error("[ROUTER] Route constraint '" + constraint + "' not found. Is it defined in '/workspace/routes/constraints.js' or '/workspace/data-sources/'?");
  }

  return;
}

/**
 *  Attaches a function from /workspace/routes/constraints.js to the specified route
 *  @param {String} route
 *  @return `true` if `route` can be handled by a route handler, or if no handler matches the route. `false`
 *  if a route handler matches but returned false when tested.
 *  @api public
 */
Router.prototype.testConstraint = function(route, req, res, callback) {

  console.log("[ROUTER] testConstraint: " + req.url);
  console.log("[ROUTER] testConstraint: " + route);

  // if there's a constraint handler 
  // for this route, run it
  if (this.constraints[route]) {

    if (typeof this.constraints[route] === 'function') {
      this.constraints[route](req, res, function (result) {
        // return the result
        return callback(result);
      });
    }
    else {
      // datasource
      var datasource = this.constraints[route];
      datasource.processRequest(datasource.page.name, req);

      help.getData(datasource, function(err, result) {
        
        if (err) {
          return callback(err);
        }

        if (result) {
          try {
            var results = JSON.parse(result);
            // console.log(results);
            if (results && results.results && results.results.length > 0) {
              return callback(true);
            }
            else {
              return callback(false);  
            }
          }
          catch (err) {
            log.error(err);
            return callback(false);
          }
        }
      });
    }
  }
  else {
    // no constraint against this route,
    // let's use it
    return callback(true);
  }
}

Router.prototype.loadRewriteModule = function() {
  // remove it from the stack
  this.server.app.unuse(modRewrite(this.rules));

  log.info("[ROUTER] Rewrite module unloaded.");

  // add it to the stack
  this.server.app.use(modRewrite(this.rules));
  
  log.info("[ROUTER] Rewrite module loaded.");
  log.info("[ROUTER] " + this.rules.length + " rewrites/redirects loaded.");
}

var debugMode = function(req) {
  var query = url.parse(req.url, true).query;
  return (query.debug && query.debug.toString() === 'true');
}

module.exports = function (server, options) {

  var self = this;

  server.app.Router = new Router(server, options);

  // middleware which blocks requests when we're too busy
	// server.app.use(function (req, res, next) {
	//   if (toobusy()) {
	//     var err = new Error();
 //      err.statusCode = 503;
 //      err.json = { 'error' : 'HTTP Error 503 - Service unavailable' };
 //      next(err);
	//   }
	//   else {
	//     next();
	//   }
	// });
 

  server.app.use(function (req, res, next) {

    if (!server.app.Router.rewritesDatasource || server.app.Router.rewritesDatasource === '') return next();

    var datasource = new Datasource('rewrites', server.app.Router.rewritesDatasource, options, function(err, ds) {
      
      if (err) {
        log.error(err);
        return next();
      }

      _.extend(ds.schema.datasource.filter, { "rule": req.url });
      ds.processRequest(ds.page.name, req);

      help.getData(ds, function(err, result) {
        
        if (err) return done(err);

        if (result) {
          var results = JSON.parse(result);
          
          if (results && results.results && results.results.length > 0) {
            var rule = results.results[0];
            var location;
            if (/\:\/\//.test(rule.replacement)) {
              location = req.url.replace(rule.rule, rule.replacement);
            }
            else {
              location = 'http' + '://' + req.headers.host + req.url.replace(rule.rule, rule.replacement);
            }

            res.writeHead(rule.redirectType, {
              Location : location
            });

            res.end();
          }
          else {
            return next();
          }
        }
        else {
          return next();
        }
      });

    });
  })

  //server.app.Router.loadRewriteModule();
};

module.exports.Router = Router;
