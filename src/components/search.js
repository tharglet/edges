$.extend(edges, {
    //////////////////////////////////////////////////
    // Arbitrary filter-selector

    newFilterSetter : function(params) {
        if (!params) { params = {} }
        edges.FilterSetter.prototype = edges.newComponent(params);
        return new edges.FilterSetter(params);
    },
    FilterSetter : function(params) {
        /*
        [
            {
                id : "<identifier for this filter within the scope of this component>",
                display: "<How this filter should be described in the UI>",
                must : [<list of query object filters to be applied/removed if this filter is selected/removed>],
                agg_name : "<name of aggregation which informs this filter (defined in this.aggregations)>",
                bucket_field : "<field in the bucket to look in>",
                bucket_value: "<value in the bucket_field to match>"
            }
        ]
        */
        this.filters = edges.getParam(params.filters, []);

        this.aggregations = edges.getParam(params.aggregations, []);

        this.defaultRenderer = edges.getParam(params.defaultRenderer, "newFilterSetterRenderer");

        //////////////////////////////////////////
        // properties used to store internal state

        // map of filter id to document count from aggregation
        this.filter_counts = {};

        // map of filter id to whether it is active or not
        this.active_filters = {};

        //////////////////////////////////////////
        // overrides on the parent object's standard functions

        this.contrib = function(query) {
            for (var i = 0; i < this.aggregations.length; i++) {
                query.addAggregation(this.aggregations[i]);
            }
        };

        this.synchronise = function() {
            // first pull the count information from the aggregations
            for (var i = 0; i < this.filters.length; i++) {
                var filter_def = this.filters[i];

                if (!filter_def.agg_name || !filter_def.bucket_field || !filter_def.bucket_value) {
                    continue;
                }

                var agg = this.edge.result.aggregation(filter_def.agg_name);
                if (!agg) {
                    continue;
                }

                var bfield = filter_def.bucket_field;
                var bvalue = filter_def.bucket_value;
                var count = 0;

                var buckets = agg.buckets;
                for (var k = 0; k < buckets.length; k++) {
                    var bucket = buckets[k];
                    if (bucket[bfield] && bucket[bfield] == bvalue) {
                        count = bucket["doc_count"];
                        break;
                    }
                }

                this.filter_counts[filter_def.id] = count;
            }

            // now extract all the existing filters to find out if any of ours are active
            for (var i = 0; i < this.filters.length; i++) {
                var filter_def = this.filters[i];
                if (!filter_def.must) {
                    continue;
                }

                var toactivate = filter_def.must.length;
                var active = 0;
                for (var j = 0; j < filter_def.must.length; j++) {
                    var must = filter_def.must[j];
                    var current = this.edge.currentQuery.listMust(must);
                    if (current.length > 0) {
                        active += 1;
                    }
                }
                if (active === toactivate) {
                    this.active_filters[filter_def.id] = true;
                } else {
                    this.active_filters[filter_def.id] = false;
                }
            }
        };

        //////////////////////////////////////////
        // functions that can be called on this component to change its state

        this.addFilter = function(filter_id) {
            var filter = false;
            for (var i = 0; i < this.filters.length; i++) {
                if (this.filters[i].id === filter_id) {
                    filter = this.filters[i];
                    break;
                }
            }

            if (!filter || !filter.must) {
                return;
            }

            var nq = this.edge.cloneQuery();

            // add all of the must filters to the query
            for (var i = 0; i < filter.must.length; i++) {
                var must = filter.must[i];
                nq.addMust(must);
            }

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.removeFilter = function(filter_id) {
            var filter = false;
            for (var i = 0; i < this.filters.length; i++) {
                if (this.filters[i].id === filter_id) {
                    filter = this.filters[i];
                    break;
                }
            }

            if (!filter || !filter.must) {
                return;
            }

            var nq = this.edge.cloneQuery();

            // add all of the must filters to the query
            for (var i = 0; i < filter.must.length; i++) {
                var must = filter.must[i];
                nq.removeMust(must);
            }

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };
    },

    //////////////////////////////////////////////////
    // Search controller implementation and supporting search navigation/management

    newFullSearchController: function (params) {
        if (!params) {
            params = {}
        }
        edges.FullSearchController.prototype = edges.newComponent(params);
        return new edges.FullSearchController(params);
    },
    FullSearchController: function (params) {
        // if set, should be either * or ~
        // if *, * will be prepended and appended to each string in the freetext search term
        // if ~, ~ then ~ will be appended to each string in the freetext search term.
        // If * or ~ or : are already in the freetext search term, no action will be taken.
        this.fuzzify = params.fuzzify || false;

        // list of options by which the search results can be sorted
        // of the form of a list, thus: [{ field: '<field to sort by>', dir: "<sort dir>", display: '<display name>'}],
        this.sortOptions = params.sortOptions || false;

        // list of options for fields to which free text search can be constrained
        // of the form of a list thus: [{ field: '<field to search on>', display: '<display name>'}],
        this.fieldOptions = params.fieldOptions || false;

        // provide a function which will do url shortening for the share/save link
        this.urlShortener = params.urlShortener || false;

        // on free-text search, default operator for the elasticsearch query system to use
        this.defaultOperator = params.defaultOperator || "OR";

        this.defaultRenderer = params.defaultRenderer || "newFullSearchControllerRenderer";

        ///////////////////////////////////////////////
        // properties for tracking internal state

        // field on which to focus the freetext search (initially)
        this.searchField = false;

        // freetext search string
        this.searchString = false;

        this.sortBy = false;

        this.sortDir = "desc";

        // the short url for the current search, if it has been generated
        this.shortUrl = false;

        this.synchronise = function () {
            // reset the state of the internal variables
            this.searchString = false;
            this.searchField = false;
            this.sortBy = false;
            this.sortDir = "desc";
            // this.shortUrl - not sure what to do with this one yet

            if (this.edge.currentQuery) {
                var qs = this.edge.currentQuery.getQueryString();
                if (qs) {
                    this.searchString = qs.queryString;
                    this.searchField = qs.defaultField;
                }
                var sorts = this.edge.currentQuery.getSortBy();
                if (sorts.length > 0) {
                    this.sortBy = sorts[0].field;
                    this.sortDir = sorts[0].order;
                }
            }
        };

        this.setSort = function(params) {
            var dir = params.dir;
            var field = params.field;

            if (dir === undefined || dir === false) {
                dir = "desc";
            }

            var nq = this.edge.cloneQuery();

            // replace the existing sort criteria
            nq.setSortBy(es.newSort({
                field: field,
                order: dir
            }));

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.changeSortDir = function () {
            var dir = this.sortDir === "asc" ? "desc" : "asc";
            var sort = this.sortBy ? this.sortBy : "_score";
            var nq = this.edge.cloneQuery();

            // replace the existing sort criteria
            nq.setSortBy(es.newSort({
                field: sort,
                order: dir
            }));

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.setSortBy = function (field) {
            var nq = this.edge.cloneQuery();

            // replace the existing sort criteria
            if (!field || field === "") {
                field = "_score";
            }
            nq.setSortBy(es.newSort({
                field: field,
                order: this.sortDir
            }));

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.setSearchField = function (field) {
            // track the search field, as this may not trigger a search
            this.searchField = field;
            if (!this.searchString || this.searchString === "") {
                return;
            }

            var nq = this.edge.cloneQuery();

            // set the query with the new search field
            nq.setQueryString(es.newQueryString({
                queryString: this.searchString,
                defaultField: field,
                defaultOperator: this.defaultOperator,
                fuzzify: this.fuzzify
            }));

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.setSearchText = function (text) {
            var nq = this.edge.cloneQuery();

            if (text !== "") {
                var params = {
                    queryString: text,
                    defaultOperator: this.defaultOperator,
                    fuzzify: this.fuzzify
                };
                if (this.searchField && this.searchField !== "") {
                    params["defaultField"] = this.searchField;
                }
                // set the query with the new search field
                nq.setQueryString(es.newQueryString(params));
            } else {
                nq.removeQueryString();
            }

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.clearSearch = function () {
            this.edge.reset();
        };
    },

    newSelectedFilters: function (params) {
        if (!params) {
            params = {}
        }
        edges.SelectedFilters.prototype = edges.newComponent(params);
        return new edges.SelectedFilters(params);
    },
    SelectedFilters: function (params) {
        //////////////////////////////////////////
        // configuration options to be passed in

        // mapping from fields to names to display them as
        // if these come from a facet/selector, they should probably line up
        this.fieldDisplays = edges.getParam(params.fieldDisplays, {});

        // value maps on a per-field basis for Term(s) filters, to apply to values before display.
        // if these come from a facet/selector, they should probably be the same maps
        // {"<field>" : {"<value>" : "<display>"}}
        this.valueMaps = edges.getParam(params.valueMaps, {});

        // value functions on a per-field basis for Term(s) filters, to apply to values before display.
        // if these come from a facet/selector, they should probably be the same functions
        // {"<field>" : <function>}
        this.valueFunctions = edges.getParam(params.valueFunctions, {});

        // range display maps on a per-field basis for Range filters
        // if these come from a facet/selector, they should probably be the same maps
        // {"<field>" : [{"from" : "<from>", "to" : "<to>", "display" : "<display>"}]}
        this.rangeMaps = edges.getParam(params.rangeMaps, {});

        // range display functions on a per-field basis for Range filters
        // useful if you have a range selector which allows arbitrary ranges
        // {"<field>" : <function (receives field name, from and to as params dict)>}
        // must return {to: to, from: from, display: display}
        this.rangeFunctions = edges.getParam(params.rangeFunctions, {});

        // function to use to format any range that does not appear in the range maps
        this.formatUnknownRange = edges.getParam(params.formatUnknownRange, false);

        // override the parent's default renderer
        this.defaultRenderer = edges.getParam(params.defaultRenderer, "newSelectedFiltersRenderer");

        //////////////////////////////////////////
        // properties used to store internal state

        // active filters to be rendered out
        // each of the form:
        /*
         {
         filter : "<type name of filter used>"
         display: "<field display name>",
         rel: "<relationship between values (e.g. AND, OR)>",
         values: [
         {display: "<display value>", val: "<actual value>"}
         ]
         }
         */
        this.mustFilters = {};

        this.searchString = false;
        this.searchField = false;

        this.synchronise = function () {
            // reset the state of the internal variables
            this.mustFilters = {};
            this.searchString = false;
            this.searchField = false;

            if (!this.edge.currentQuery) {
                return;
            }

            var musts = this.edge.currentQuery.listMust();
            for (var i = 0; i < musts.length; i++) {
                var f = musts[i];
                if (f.type_name === "term") {
                    this._synchronise_term(f);
                } else if (f.type_name === "terms") {
                    this._synchronise_terms(f);
                } else if (f.type_name === "range") {
                    this._synchronise_range(f);
                } else if (f.type_name === "geo_distance_range") {

                }
            }

            var qs = this.edge.currentQuery.getQueryString();
            if (qs) {
                this.searchString = qs.queryString;
                this.searchField = qs.defaultField;
            }
        };

        this.removeFilter = function (boolType, filterType, field, value) {
            var nq = this.edge.cloneQuery();

            if (filterType === "term") {
                var template = es.newTermFilter({field: field, value: value});

                if (boolType === "must") {
                    nq.removeMust(template);
                }

            } else if (filterType === "terms") {
                var template = es.newTermsFilter({field: field});

                if (boolType === "must") {
                    var filters = nq.listMust(template);
                    for (var i = 0; i < filters.length; i++) {
                        if (filters[i].has_term(value)) {
                            filters[i].remove_term(value);
                        }

                        // if this means the filter no longer has values, remove the filter
                        if (!filters[i].has_terms()) {
                            nq.removeMust(filters[i]);
                        }
                    }
                }

            } else if (filterType == "range") {
                var params = {field: field};
                if (value.to) {
                    params["lt"] = value.to;
                }
                if (value.from) {
                    params["gte"] = value.from;
                }
                var template = es.newRangeFilter(params);

                if (boolType === "must") {
                    nq.removeMust(template);
                }

            } else if (filterType == "geo_distance_range") {

            }

            // reset the page to zero and reissue the query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.clearQueryString = function () {
            var nq = this.edge.cloneQuery();
            nq.removeQueryString();

            // reset the search page to the start and then trigger the next query
            nq.from = 0;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.clearSearch = function () {
            this.edge.reset();
        };

        this._synchronise_term = function (filter) {
            var display = this.fieldDisplays[filter.field] || filter.field;

            // multiple term filters mean AND, so group them together here
            if (filter.field in this.mustFilters) {
                this.mustFilters[filter.field].values.push({
                    val: filter.value,
                    display: this._translate(filter.field, filter.value)
                })
            } else {
                this.mustFilters[filter.field] = {
                    filter: filter.type_name,
                    display: display,
                    values: [{val: filter.value, display: this._translate(filter.field, filter.value)}],
                    rel: "AND"
                }
            }
        };

        this._synchronise_terms = function (filter) {
            var display = this.fieldDisplays[filter.field] || filter.field;
            var values = [];
            for (var i = 0; i < filter.values.length; i++) {
                var v = filter.values[i];
                var d = this._translate(filter.field, v);
                values.push({val: v, display: d});
            }
            this.mustFilters[filter.field] = {
                filter: filter.type_name,
                display: display,
                values: values,
                rel: "OR"
            }
        };

        this._synchronise_range = function (filter) {
            var display = this.fieldDisplays[filter.field] || filter.field;
            var to = filter.lt;
            if (to === false) {
                to = filter.lte;
            }
            var from = filter.gte;
            var r = this._getRangeDef(filter.field, from, to);
            var values = [];
            if (!r) {
                values.push({to: to, from: from, display: this._formatUnknown(from, to)});
            } else {
                values.push(r);
            }

            this.mustFilters[filter.field] = {
                filter: filter.type_name,
                display: display,
                values: values
            }
        };

        this._translate = function (field, value) {
            if (field in this.valueMaps) {
                if (value in this.valueMaps[field]) {
                    return this.valueMaps[field][value];
                }
            } else if (field in this.valueFunctions) {
                return this.valueFunctions[field](value);
            }
            return value;
        };

        this._getRangeDef = function (field, from, to) {
            if (!this.rangeMaps[field] && !this.rangeFunctions[field]) {
                return false;
            }
            if (this.rangeMaps[field]) {
                for (var i = 0; i < this.rangeMaps[field].length; i++) {
                    var r = this.rangeMaps[field][i];
                    var frMatch = true;
                    var toMatch = true;
                    // if one is set and the other not, no match
                    if ((from && !r.from) || (!from && r.from)) {
                        frMatch = false;
                    }
                    if ((to && !r.to) || (!to && r.to)) {
                        toMatch = false;
                    }

                    // if both set, and they don't match, no match
                    if (from && r.from && from !== r.from) {
                        frMatch = false;
                    }
                    if (to && r.to && to !== r.to) {
                        toMatch = false;
                    }

                    // both have to match for a match
                    if (frMatch && toMatch) {
                        return r
                    }
                }
            } else if (this.rangeFunctions[field]) {
                var fn = this.rangeFunctions[field];
                return fn({field: field, from: from, to: to});
            }

            return false;
        };

        this._formatUnknown = function (from, to) {
            if (this.formatUnknownRange) {
                return this.formatUnknownRange(from, to)
            } else {
                // if they're the same just return one of them
                if (from !== false || to !== false) {
                    if (from === to) {
                        return from;
                    }
                }

                // otherwise calculate the display for the range
                var frag = "";
                if (from !== false) {
                    frag += from;
                } else {
                    frag += "< ";
                }
                if (to !== false) {
                    if (from !== false) {
                        frag += " - " + to;
                    } else {
                        frag += to;
                    }
                } else {
                    if (from !== false) {
                        frag += "+";
                    } else {
                        frag = "unknown";
                    }
                }
                return frag;
            }
        };
    },

    newPager: function (params) {
        if (!params) {
            params = {}
        }
        edges.Pager.prototype = edges.newComponent(params);
        return new edges.Pager(params);
    },
    Pager: function (params) {

        this.defaultRenderer = params.defaultRenderer || "newPagerRenderer";

        ///////////////////////////////////////
        // internal state

        this.from = false;
        this.to = false;
        this.total = false;
        this.page = false;
        this.pageSize = false;
        this.totalPages = false;

        this.synchronise = function () {
            // reset the state of the internal variables
            this.from = false;
            this.to = false;
            this.total = false;
            this.page = false;
            this.pageSize = false;
            this.totalPages = false;

            // calculate the properties based on the latest query/results
            if (this.edge.currentQuery) {
                this.from = parseInt(this.edge.currentQuery.getFrom()) + 1;
                this.pageSize = parseInt(this.edge.currentQuery.getSize());
            }
            if (this.edge.result) {
                this.total = this.edge.result.total()
            }
            if (this.from !== false && this.total !== false) {
                this.to = this.from + this.pageSize - 1;
                this.page = Math.ceil((this.from - 1) / this.pageSize) + 1;
                this.totalPages = Math.ceil(this.total / this.pageSize)
            }
        };

        this.setFrom = function (from) {
            var nq = this.edge.cloneQuery();

            from = from - 1; // account for the human readability of the value, ES is 0 indexed here
            if (from < 0) {
                from = 0;
            }
            nq.from = from;

            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.setSize = function (size) {
            var nq = this.edge.cloneQuery();
            nq.size = size;
            this.edge.pushQuery(nq);
            this.edge.doQuery();
        };

        this.decrementPage = function () {
            var from = this.from - this.pageSize;
            this.setFrom(from);
        };

        this.incrementPage = function () {
            var from = this.from + this.pageSize;
            this.setFrom(from);
        };

        this.goToPage = function(params) {
            var page = params.page;
            var nf = ((page - 1) * this.pageSize) + 1;  // we're working with the human notion of from, here, so is indexed from 1
            this.setFrom(nf);
        }
    },

    newSearchingNotification: function (params) {
        if (!params) {
            params = {}
        }
        edges.SearchingNotification.prototype = edges.newComponent(params);
        return new edges.SearchingNotification(params);
    },
    SearchingNotification: function (params) {
        this.defaultRenderer = params.defaultRenderer || "newSearchingNotificationRenderer";

        this.searching = false;

        this.init = function (edge) {
            Object.getPrototypeOf(this).init.call(this, edge);
            // this.__proto__.init.call(this, edge);
            edge.context.on("edges:pre-query", edges.eventClosure(this, "searchingBegan"));
            edge.context.on("edges:query-fail", edges.eventClosure(this, "searchingFinished"));
            edge.context.on("edges:query-success", edges.eventClosure(this, "searchingFinished"));
        };

        // specifically disable this function
        this.draw = function () {
        };

        this.searchingBegan = function () {
            this.searching = true;
            this.renderer.draw();
        };

        this.searchingFinished = function () {
            this.searching = false;
            this.renderer.draw();
        };
    },

    ////////////////////////////////////////////////
    // Results list implementation

    newResultsDisplay: function (params) {
        if (!params) {
            params = {}
        }
        edges.ResultsDisplay.prototype = edges.newComponent(params);
        return new edges.ResultsDisplay(params);
    },
    ResultsDisplay: function (params) {
        ////////////////////////////////////////////
        // arguments that can be passed in

        // the category of the component
        this.category = params.category || "results";

        // the default renderer for the component to use
        this.defaultRenderer = params.defaultRenderer || "newResultsDisplayRenderer";

        //////////////////////////////////////
        // variables for tracking internal state

        // the results retrieved from ES.  If this is "false" this means that no synchronise
        // has been called on this object, which in turn means that initial searching is still
        // going on.  Once initialised this will be a list (which may in turn be empty, meaning
        // that no results were found)
        this.results = false;

        this.synchronise = function () {
            // reset the state of the internal variables
            this.results = [];

            if (this.edge.result) {
                this.results = this.edge.result.results();
            }
        }
    }
});
