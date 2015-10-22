var fs = require('fs');
var url = require('url');
var _ = require('underscore');
var log = require(__dirname + '/../log');
var BearerAuthStrategy = require(__dirname + '/../auth/bearer');

var Datasource = function (page, datasource, options, callback) {
  
  this.page = page;
  this.name = datasource;
  this.options = options || {};

  var self = this;

  this.loadDatasource(function(err, schema) {

    if (err) {
      return callback(err);
    }

    self.schema = schema;
    self.source = schema.datasource.source;
    self.schema.datasource.filter = self.schema.datasource.filter || {};
    
    if (self.source.type === 'static') {
      callback(self);
    }

    self.requestParams = schema.datasource.requestParams || [];
    self.chained = schema.datasource.chained || null;
    self.authStrategy = self.setAuthStrategy();

    self.buildEndpoint(schema, function() {
      //self.endpoint = endpoint;
      callback(null, self);
    });
  });

};

Datasource.prototype.loadDatasource = function(done) {

  var filepath = (this.options.datasourcePath || '') + '/' + this.name + '.json';
  var schema;
  
  try {
    var body = fs.readFileSync(filepath, {encoding: 'utf-8'});

    schema = JSON.parse(body);
    done(null, schema);
  }
  catch (err) {
    log.error({'err': err}, 'Error loading datasource schema "' + filepath + '". Is it valid JSON?');
    done(err);
  }
};

Datasource.prototype.setAuthStrategy = function() {
  
  if (!this.schema.datasource.auth) return null;

//  var authConfig = {};

  // load the auth configuration file
  // var authConfigPath = __dirname + '/../../../config.auth.json';
  // if (fs.existsSync(authConfigPath)) {
  //   try {
  //     var body = fs.readFileSync(authConfigPath, {encoding: 'utf-8'});
  //     authConfig = JSON.parse(body);
  //   }
  //   catch (err) {
  //     throw new Error('Error loading datasource auth config "' + filepath + '". Is it valid JSON? ' + err);
  //   }
  // }
    
  // var authBlock = this.schema.datasource.auth;

  // if (typeof authBlock === 'string' && authConfig[authBlock]) {
  //   this.schema.datasource.auth = authConfig[authBlock];
  // }
  
  return new BearerAuthStrategy(this.schema.datasource.auth);
};

Datasource.prototype.buildEndpoint = function(schema, done) {
  
  if (schema.datasource.source.type === 'static') return;
  
  var self = this;
  var uri = "";

  var protocol = schema.datasource.source.protocol || 'http';
  var host = schema.datasource.source.host || '';
  var port = schema.datasource.source.port || '';
  
  uri = [protocol, '://', host, port != '' ? ':' : '', port, '/', schema.datasource.source.endpoint].join('');

  self.endpoint = self.processDatasourceParameters(schema, uri);
  done();
};

Datasource.prototype.processDatasourceParameters = function (schema, uri) {

  var query = '?';
  
  var params = [
    {"count": (schema.datasource.count || 0)},
    {"page": (schema.datasource.page || 1)},
    //{"search": schema.datasource.search},
    {"filter": schema.datasource.filter || {}},
    {"fields": schema.datasource.fields || {}},
    {"sort": processSortParameter(schema.datasource.sort)}
  ];

  // pass cache flag to Serama endpoint
  if (schema.datasource.hasOwnProperty('cache')) {
    params.push({"cache": schema.datasource.cache});
  }

  params.forEach(function(param) {
    for (key in param) {
      if (param.hasOwnProperty(key) && (typeof param[key] !== 'undefined')) {
        query = query + key + "=" + (_.isObject(param[key]) ? JSON.stringify(param[key]) : param[key]) + '&';
      }
    }

    // if (params.indexOf(param) === (params.length-1)) {
    //   done(uri + query.slice(0,-1));
    // }
  });

  return uri + query.slice(0,-1);
}

Datasource.prototype.processRequest = function (datasource, req) {

  var self = this;

  var query = url.parse(req.url, true).query;

  // remove debug params from query
  delete query.debug;
  delete query.json;

  // handle the cache flag
  if (query.hasOwnProperty('cache') && query.cache === 'false') {
    delete query.cache;
    this.schema.datasource.cache = false;
  }
  else {
    delete this.schema.datasource.cache;
  }

  // if the current datasource matches the page name
  // add some params from the query string or request params
  if (this.page.name && datasource.indexOf(this.page.name) >= 0) {
    
    // handle pagination param
    this.schema.datasource.page = query.page || req.params.page || 1;
    delete query.page;
    delete req.params.page;
    
    // add an ID filter if it was present in the querystring
    // either as http://www.blah.com?id=xxx or via a route parameter e.g. /books/:id
    if (req.params.id || query.id) {
      this.schema.datasource.filter['_id'] = req.params.id || query.id;
      delete query.id;
    }

    // URI encode each querystring value
    _.each(query, function(value, key) {
      if (key === 'filter') {
        _.extend(this.schema.datasource.filter, JSON.parse(value));
      }
      else {
        this.schema.datasource.filter[key] = encodeURIComponent(value);
      }
    }, this);
  }

  // add the datasource's requestParams, testing for their existence
  // in the querystring's request params e.g. /car-reviews/:make/:model
  _.each(this.requestParams, function(obj) {
    if (req.params.hasOwnProperty(obj.param)) {
      this.schema.datasource.filter[obj.field] = encodeURIComponent(req.params[obj.param]);
    }
    else {
      // param not found in request, remove it from DS filter
      if (this.schema.datasource.filter[obj.field]) {
        delete this.schema.datasource.filter[obj.field];
      }
    }
  }, this);

  this.buildEndpoint(this.schema, function() {});
}

function processSortParameter(obj) {
  var sort = {};
  if (typeof obj !== 'object' || obj === null) return sort;

  _.each(obj, function(value, key) {    
    if (typeof value === 'object' && value.hasOwnProperty('field') && value.hasOwnProperty('order')) {
      sort[value.field] = (value.order === 'asc') ? 1 : -1;
    }
  });

  return sort;
}

module.exports = function (page, datasource, options, callback) {
  return new Datasource(page, datasource, options, callback);
};

module.exports.Datasource = Datasource;
