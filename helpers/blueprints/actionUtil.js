/**
 * Module dependencies
 */

var util = require('util');
var {isString, isArray, isObject, isUndefined} = require('lodash');
var _ = require('lodash'); // TODO: replace lodash with individual per-method packages
var mergeDefaults = _.defauts;


// Parameter used for jsonp callback is constant, as far as
// blueprints are concerned (for now.)
var JSONP_CALLBACK_PARAM = 'callback';



/**
 * Utility methods used in built-in blueprint actions.
 *
 * @type {Object}
 */
var actionUtil = {

  /**
   * Given a Waterline query and an express request, populate
   * the appropriate/specified association attributes and
   * return it so it can be chained further ( i.e. so you can
   * .exec() it )
   *
   * @param  {Query} query         [waterline query object]
   * @param  {Request} req
   * @return {Query}
   */
  populateRequest: function(query, req) {
    var DEFAULT_POPULATE_LIMIT = 30;
    var _options = req.options;
    var aliasFilter = req.query.populate || req.params.populate || req.body.populate;
    var shouldPopulate = _options.populate;

    // Convert the string representation of the filter list to an Array. We
    // need this to provide flexibility in the request param. This way both
    // list string representations are supported:
    //   /model?populate=alias1,alias2,alias3
    //   /model?populate=[alias1,alias2,alias3]
    if (typeof aliasFilter === 'string') {
      aliasFilter = aliasFilter.replace(/\[|\]/g, '');
      aliasFilter = (aliasFilter) ? aliasFilter.split(',') : [];
    }

    var associations = [];

    _.each(_options.associations, function(association) {
      // If an alias filter was provided, override the blueprint config.
      if (aliasFilter) {
        shouldPopulate = _.contains(aliasFilter, association.alias);
      }

      // Only populate associations if a population filter has been supplied
      // with the request or if `populate` is set within the blueprint config.
      // Population filters will override any value stored in the config.
      //
      // Additionally, allow an object to be specified, where the key is the
      // name of the association attribute, and value is true/false
      // (true to populate, false to not)
      if (shouldPopulate) {
        var populationLimit =
          _options['populate_' + association.alias + '_limit'] ||
          _options.populate_limit ||
          _options.limit ||
          DEFAULT_POPULATE_LIMIT;

        associations.push({
          alias: association.alias,
          limit: populationLimit
        });
      }
    });

    return actionUtil.populateQuery(query, associations, req._sails);
  },

  /**
   * Given a Waterline query and Waterline model, populate the
   * appropriate/specified association attributes and return it
   * so it can be chained further ( i.e. so you can .exec() it )
   *
   * @param  {Query} query         [waterline query object]
   * @param  {Model} model         [waterline model object]
   * @return {Query}
   */
  populateModel: function(query, model) {
    return actionUtil.populateQuery(query, model.associations);
  },


 /**
  * Given a Waterline query, populate the appropriate/specified
  * association attributes and return it so it can be chained
  * further ( i.e. so you can .exec() it )
  *
  * @param  {Query} query         [waterline query object]
  * @param  {Array} associations  [array of objects with an alias
  *                                and (optional) limit key]
  * @return {Query}
  */
  populateQuery: function(query, associations, sails) {
    var DEFAULT_POPULATE_LIMIT = (sails && sails.config.blueprints.defaultLimit) || 30;

    return _.reduce(associations, function(query, association) {
      return query.populate(association.alias, {
        limit: association.limit || DEFAULT_POPULATE_LIMIT
      });
    }, query);
  },


  /**
   * Parse primary key value for use in a Waterline criteria
   * (e.g. for `find`, `update`, or `destroy`)
   *
   * @param  {Request} req
   * @return {Integer|String}
   */
  parsePk: function ( req ) {
    var pk = req.options.id || (req.options.where && req.options.where.id) || req.query.id || req.params.id;

    // TODO: make this smarter...
    // (e.g. look for actual primary key of model and look for it
    //  in the absence of `id`.)
    // See coercePK for reference (although be aware it is not currently in use)

    // exclude criteria on id field
    pk = _.isPlainObject(pk) ? undefined : pk;
    return pk;
  },



  /**
   * Parse primary key value from parameters.
   * Throw an error if it cannot be retrieved.
   *
   * @param  {Request} req
   * @return {Integer|String}
   */
  requirePk: function (req) {
    var pk = module.exports.parsePk(req);

    // Validate the required `id` parameter
    if ( !pk ) {

      var err = new Error(
      'No `id` parameter provided.'+
      '(Note: even if the model\'s primary key is not named `id`- '+
      '`id` should be used as the name of the parameter- it will be '+
      'mapped to the proper primary key name)'
      );
      err.status = 400;
      throw err;
    }

    return pk;
  },



  /**
   * Parse `criteria` for a Waterline `find` or `update` from all
   * request parameters.
   *
   * @param  {Request} req
   * @return {Object}            the WHERE criteria object
   */
  parseCriteria: function ( req ) {

    // Allow customizable blacklist for params NOT to include as criteria.
    req.options.criteria = req.options.criteria || {};
    req.options.criteria.blacklist = req.options.criteria.blacklist || ['limit', 'skip', 'sort', 'populate'];

    // Validate blacklist to provide a more helpful error msg.
    var blacklist = req.options.criteria && req.options.criteria.blacklist;
    if (blacklist && !isArray(blacklist)) {
      throw new Error('Invalid `req.options.criteria.blacklist`. Should be an array of strings (parameter names.)');
    }

    // Look for explicitly specified `where` parameter.
    var where = req.params.where || req.query.where || req.body.where;

    // If `where` parameter is a string, try to interpret it as JSON
    if (isString(where)) {
      where = tryToParseJSON(where);
    }

    // If `where` has not been specified, but other unbound parameter variables
    // **ARE** specified, build the `where` option using them.
    if (!where) {

      // Prune params which aren't fit to be used as `where` criteria
      // to build a proper where query
      where = req.query;

      // Omit built-in runtime config (like query modifiers)
      where = _.omit(where, blacklist || ['limit', 'skip', 'sort']);

      // Omit any params w/ undefined values
      where = _.omit(where, function(p) {
        if (isUndefined(p)) {return true;}
      });

      // Omit jsonp callback param (but only if jsonp is enabled)
      var jsonpOpts = req.options.jsonp && !req.isSocket;
      jsonpOpts = isObject(jsonpOpts) ? jsonpOpts : { callback: JSONP_CALLBACK_PARAM };
      if (jsonpOpts) {
        where = _.omit(where, [jsonpOpts.callback]);
      }
    }

    // Merge w/ req.options.where and return
    where = _.merge({}, req.options.where || {}, where) || undefined;

    return where;
  },


  /**
   * Parse `values` for a Waterline `create` or `update` from all
   * request parameters.
   *
   * @param  {Request} req
   * @return {Object}
   */
  parseValues: function (req) {

    // Allow customizable blacklist for params NOT to include as values.
    req.options.values = req.options.values || {};
    req.options.values.blacklist = req.options.values.blacklist;

    // Validate blacklist to provide a more helpful error msg.
    var blacklist = req.options.values.blacklist;
    if (blacklist && !isArray(blacklist)) {
      throw new Error('Invalid `req.options.values.blacklist`. Should be an array of strings (parameter names.)');
    }

    // Start an array to hold values
    var values;

    // Make an array out of the request body data if it wasn't one already;
    // this allows us to process multiple entities (e.g. for use with a "create" blueprint) the same way
    // that we process singular entities.
    var bodyData = isArray(req.body) ? req.body : [_.merge(req.params, req.query, req.body)];

    // Process each item in the bodyData array, merging with req.options, omitting blacklisted properties, etc.
    var valuesArray = _.map(bodyData, function(element){
      var values;
      // Merge properties of the element into req.options.value, omitting the blacklist
      values = _.defaults(element, _.omit(req.options.values, 'blacklist'));
      // Omit properties that are in the blacklist (like query modifiers)
      values = _.omit(values, blacklist || []);
      // Omit any properties w/ undefined values
      values = _.omit(values, function(p) {
        if (isUndefined(p)) {
          return true;
        }
      });

      return values;
    });

    // If req.body is an array, simply return our array of processed values
    if (isArray(req.body)) {return valuesArray;}

    // Otherwaise grab the first (and only) value from valuesArray
    values = valuesArray[0];

    // Omit jsonp callback param (but only if jsonp is enabled)
    var jsonpOpts = req.options.jsonp && !req.isSocket;
    jsonpOpts = isObject(jsonpOpts) ? jsonpOpts : { callback: JSONP_CALLBACK_PARAM };
    if (jsonpOpts) {
      values = _.omit(values, [jsonpOpts.callback]);
    }

    return values;
  },



  /**
   * Determine the model class to use w/ this blueprint action.
   * @param  {Request} req
   * @return {WLCollection}
   */
  parseModel: function (req) {

    // Ensure a model can be deduced from the request options.
    var model = req.options.model || req.options.controller;
    if (!model) throw new Error(util.format('No "model" specified in route options.'));

    var Model = req._sails.models[model];
    if ( !Model ) throw new Error(util.format('Invalid route option, "model".\nI don\'t know about any models named: `%s`',model));

    return Model;
  },



  /**
   * @param  {Request} req
   */
  parseSort: function (req) {
    var sort = req.query.sort || req.body.sort || req.options.sort;
    if (isUndefined(sort)) {return undefined;}

    // If `sort` is a string, attempt to JSON.parse() it.
    // (e.g. `{"name": 1}`)
    if (isString(sort)) {
      try {
        sort = JSON.parse(sort);
      }
      // If it is not valid JSON, then fall back to interpreting it as-is.
      // (e.g. "name ASC")
      catch(e) {}
    }
    return sort;
  },

  /**
   * @param  {Request} req
   */
  parseLimit: function (req) {
    var DEFAULT_LIMIT = 30;
    var limit = req.query.limit || req.body.limit || (typeof req.options.limit !== 'undefined' ? req.options.limit : DEFAULT_LIMIT);
    if (limit) { limit = +limit; }
    return limit;
  },


  /**
   * @param  {Request} req
   */
  parseSkip: function (req) {
    var DEFAULT_SKIP = 0;
    var skip = req.query.skip || req.body.skip || (typeof req.options.skip !== 'undefined' ? req.options.skip : DEFAULT_SKIP);
    if (skip) { skip = +skip; }
    return skip;
  }
};






// TODO:
//
// Replace the following helper with the version in sails.util:

// Attempt to parse JSON
// If the parse fails, return the error object
// If JSON is falsey, return null
// (this is so that it will be ignored if not specified)
function tryToParseJSON (json) {
  if (!isString(json)) return null;
  try {
    return JSON.parse(json);
  }
  catch (e) { return e; }
}

module.exports = actionUtil;
