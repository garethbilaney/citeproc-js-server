/*
    ***** BEGIN LICENSE BLOCK *****
    
    This file is part of the citeproc-node Server.
    
    Copyright © 2010 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

//include required builtin modules
//var repl = require('repl');
var fs = require('fs');
var http = require('http');
var url = require('url');

//global namespace citation server variable
var zcite = {};
global.zcite = zcite;

zcite.config = JSON.parse(fs.readFileSync('./citeServerConf.json', 'utf8'));

//process command line args
var args = process.argv;
for(var i = 1; i < args.length; i++){
    if(args[i].substr(0, 4) == 'port'){
        zcite.config.listenport = parseInt(args[i].substr(5));
    }
}

//load non-builtin modules using paths from config
var Step = require(zcite.config.stepPath);
var parser = require(zcite.config.parserPath);

zcite.CSL = require(zcite.config.citeprocmodulePath).CSL;
zcite.cslFetcher = require(zcite.config.cslFetcherPath).cslFetcher;
zcite.cslFetcher.init(zcite.config);

//set up debug/logging output
//logging, especially of errors, should be changed to be more consistent with other server log formats
if(zcite.config.debugLog == false){
    console.log("no debugLog");
    zcite.log = function(m){};
}
else{
    if(zcite.config.debugType == "file"){
        console.log("debug log file :" + zcite.config.logFile);
        zcite.logFile = process.stdout;
        /*
        zcite.logFile = fs.createWriteStream(zcite.config.logFile, {
            'flags' : 'w',
            'encoding' : 'utf8',
            'mode' : 0666
        });
        */
        zcite.log = function(m){
            zcite.logFile.write(m + '\n', 'utf8');
        };
    }
}

zcite.debug = function(m, level){
    if(typeof level == 'undefined'){level = 1;}
    if(level <= zcite.config.debugPrintLevel){
        console.log(m);
    }
};

//zcite exception response function
zcite.respondException = function(err, response, statusCode){
    zcite.debug("respondException", 5);
    zcite.debug(err, 3);
    if(typeof statusCode == 'undefined'){
        var statusCode = 500;
    }
    if(typeof response != "undefined"){
        if(typeof err == "string"){
            response.writeHead(statusCode, {'Content-Type': 'text/plain'});
            response.end("An error occurred");
            zcite.debug("caught exception : " + err, 1);
            return;
        }
        else{
            response.writeHead(statusCode, {'Content-Type': 'text/plain'});
            response.end("An error occurred");
            zcite.debug(err, 1);
            return;
        }
    }
    if(typeof err == "string"){
        //zcite.log("unCaught exception: " + err);
        zcite.debug("unCaught exception: " + err, 1);
    }
    else{
        zcite.debug('unCaught exception: ' + err.name + " : " + err.message, 1);
        //zcite.log('unCaught exception: ' + err.name + " : " + err.message);
    }
};

//preload locales into memory
zcite.localesDir = fs.readdirSync(zcite.config.localesPath);

zcite.locales = {};
for(var i = 0; i < zcite.localesDir.length; i++){
    var localeCode = zcite.localesDir[i].slice(8, 13);
    zcite.locales[localeCode] = fs.readFileSync(zcite.config.localesPath + '/' + zcite.localesDir[i], 'utf8');
}

//retrieveLocale function for use by citeproc Engine
zcite.retrieveLocale = function(lang){
    var locales = zcite.locales;
    if(locales.hasOwnProperty(lang)){
        return locales[lang];
    }
    else{
        return locales['en-US'];
    }
};

//set up style fetcher
zcite.cslXml = {};

//object for storing initialized CSL Engines by config options
//key is style, lang
zcite.cachedEngines = {};
zcite.cachedEngineCount = 0;

zcite.createEngine = function(zcreq, callback){
    //console.log(zcreq);
    zcite.debug('zcite.createEngine', 5);
    var cpSys = {
        items: zcreq.reqItemsObj,
        retrieveLocale: global.zcite.retrieveLocale,
        retrieveItem: function(itemID){return this.items[itemID];}
    };
    zcite.debug("cpSys created", 5);
    zcite.debug(zcreq.config.locale, 5);
    var citeproc = new zcite.CSL.Engine(cpSys, zcreq.cslXml, zcreq.config.locale);
    zcite.debug('engine created', 5);
    zcreq.citeproc = citeproc;
    //run the actual request now that citeproc is initialized (need to run this from cacheLoadEngine instead?)
    if(!zcite.precache){
        callback(null, zcreq);
    }
    else{
        citeproc.sys.items = {};
        zcite.cacheSaveEngine(citeproc, zcreq.styleUrlObj.href, zcreq.config.locale);
    }
};

//try to load a csl engine specified by styleuri:locale from the cache
zcite.cacheLoadEngine = function(styleUri, locale){
    zcite.debug('zcite.cacheLoadEngine', 5);
    var cacheEngineString = styleUri + ':' + locale;
    zcite.debug(cacheEngineString, 5);
    if((typeof this.cachedEngines[cacheEngineString] == 'undefined') || 
       (typeof this.cachedEngines[cacheEngineString].store == 'undefined')){
        zcite.debug("no cached engine found", 5);
        return false;
    }
    else if(this.cachedEngines[cacheEngineString].store instanceof Array){
        if(this.cachedEngines[cacheEngineString].store.length == 0){
            return false;
        }
        else{
            var citeproc = zcite.cachedEngines[cacheEngineString].store.pop();
            citeproc.sys.items = {};
            citeproc.updateItems([]);
            citeproc.restoreProcessorState();
            return citeproc;
        }
    }
    else{
        var citeproc = zcite.cachedEngines[cacheEngineString].store;
        citeproc.sys.items = {};
        citeproc.updateItems([]);
        citeproc.restoreProcessorState();
        delete zcite.cachedEngines[cacheEngineString];
        return citeproc;
    }
};

//save a csl engine specified by styleuri:locale
zcite.cacheSaveEngine = function(citeproc, styleUri, locale){
    zcite.debug('zcite.cacheSaveEngine', 5);
    var cacheEngineString = styleUri + ':' + locale;
    zcite.debug(cacheEngineString, 5);
    citeproc.sys.items = {};
    citeproc.updateItems([]);
    citeproc.restoreProcessorState();
    
    if(typeof this.cachedEngines[cacheEngineString] == 'undefined'){
        zcite.debug("saving engine", 5);
        this.cachedEngines[cacheEngineString] = {store: [citeproc], used: Date.now()};
    }
    else{
        if(this.cachedEngines[cacheEngineString].store instanceof Array){
            zcite.debug('pushing instance of engine', 5)
            this.cachedEngines[cacheEngineString].store.push(citeproc);
            this.cachedEngines[cacheEngineString].used = Date.now();
            zcite.debug('cachedEngines[cacheEngineString].length:' + this.cachedEngines[cacheEngineString].store.length, 5);
        }
    }
    
    //increment saved count and try cleaning the cache every x saves
    zcite.cachedEngineCount++;
    if(zcite.cachedEngineCount > 60){
        zcite.cleanCache();
        zcite.cachedEngineCount = 0;
    }
};

//clean up cache of engines
zcite.cleanCache = function(){
    var gcCacheArray = [];
    for(var i in this.cachedEngines){
        gcCacheArray.push(i);
    }
    if(gcCacheArray.length > zcite.config.engineCacheSize){
        gcCacheArray.sort(function(a, b){
            return zcite.cachedEngines[b].used - zcite.cachedEngines[a].used;
        });
        
        for(var i = zcite.config.engineCacheSize; i < gcCacheArray.length; i++){
            delete zcite.cachedEngines[gcCacheArray[i]];
        }
    }
    /*
    for(var i = 0; i < gcCacheArray.length; i++){
        var e = zcite.cachedEngines[gcCacheArray[i]];
        zcite.debug(gcCacheArray[i] + " : " + e.used, 5);
    }
    */
}

//precache CSL Engines on startup with style:locale 
zcite.debug('precaching CSL engines', 5);
zcite.precache = true;
Step(
/*    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('apsa'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('apa'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('asa'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
*/    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('chicago-author-date'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(err, zcreq){
        if(err) throw err;
        zcite.createEngine(zcreq);
        return true;
    },
/*    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('chicago-fullnote-bibliography'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('chicago-note-bibliography'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
/*    function fetchStyle(){
        var zcreq = {
            'reqItemsObj':{},
            'styleUrlObj':zcite.cslFetcher.processStyleIdentifier('chicago-note'),
            'config':{'locale':'en-US'}
            };
        zcite.cslFetcher.fetchStyle(zcreq, this);
    },
    function initEngine(zcreq){
        console.log('initEngine');
        zcite.createEngine(zcreq);
        return true;
    },
*/    function disablePrecache(err, success){
        zcite.debug("turn precache flag off", 5);
        if(err) throw err;
        zcite.precache = false;
        return true;
    },
    function reportDone(err, success){
        if(err) throw err;
        zcite.debug("last Step", 5);
        return true;
    }
);
    

//callback for when engine is fully initialized and ready to process the request
zcite.runRequest = function(zcreq){
    try{
        zcite.debug('zcite.runRequest', 5);
        var response = zcreq.response;
        var citeproc = zcreq.citeproc;
        var config = zcreq.config;
        var responseJson = {};
        
        //delete zcreq.citeproc;
        //zcite.debug(zcreq, 5);
        //set output format
        if(config.outputformat != "html"){
            citeproc.setOutputFormat(config.outputformat);
        }
        zcite.debug("outputFormat set", 5);
        //add items posted with request
        citeproc.updateItems(zcreq.reqItemIDs);
        if(citeproc.opt.sort_citations){
            zcite.debug("currently using a sorting style", 1);
        }
        zcite.debug("items Updated", 5);
        
        //switch process depending on bib or citation
        if(config.bibliography == "1"){
            zcite.debug('generating bib', 5);
            var bib = citeproc.makeBibliography();
            zcite.debug("bib generated", 5);
            responseJson.bibliography = bib;
        }
        if(config.citations == "1"){
            zcite.debug('generating citations', 5);
            var citations = [];
            for(var i = 0; i < zcreq.citationClusters.length; i++){
                citations.push(citeproc.appendCitationCluster(zcreq.citationClusters[i], true)[0]);
            }
            zcite.debug(citations, 5);
            responseJson.citations = citations;
        }
        
        var write = '';
        //write the CSL output to the http response
        if(config.responseformat == "json"){
            response.writeHead(200, {'Content-Type': 'application/json'});
            write = JSON.stringify(responseJson);
        }
        else{
            if(config.outputformat == 'html'){
                response.writeHead(200, {'Content-Type': 'text/html'});
            }
            else if(config.outputformat == 'rtf'){
                response.writeHead(200, {'Content-Type': 'text/rtf'});
            }
            //not sure yet what should actually be written here, but will just do assembled bib for now
            if(bib){
                write += bib[0].bibstart + bib[1].join('') + bib[0].bibend;
            }
        }
        
        response.write(write, 'utf8');
        response.end();
        zcite.debug("response sent", 5);
        
        citeproc.sys.items = {};
        zcite.cacheSaveEngine(zcreq.citeproc, zcreq.styleUrlObj.href, zcreq.config.locale);
    }
    catch(err){
        zcite.respondException(err, zcreq.response);
    }
};

zcite.configureRequest = function(uriConf){
    var config = {};
    //generate bibliography, citations, or both?
    config.bibliography = (typeof uriConf.bibliography == 'undefined' ) ? '1' : uriConf.bibliography;
    config.citations = (typeof uriConf.citations == 'undefined' ) ? '0' : uriConf.citations;
    //for csl processor's setOutputFormat (html, rtf, or text are predefined)
    config.outputformat = (typeof uriConf.outputformat == 'undefined' ) ? 'html' : uriConf.outputformat;
    config.responseformat = (typeof uriConf.responseformat == 'undefined' ) ? 'json' : uriConf.responseformat;
    //locale to use
    config.locale = (typeof uriConf.locale == 'undefined' ) ? 'en-US' : uriConf.locale;
    //CSL path or name
    config.style = (typeof uriConf.style == 'undefined' ) ? 'chicago-author-date' : uriConf.style;
    //config.cslOutput = (typeof uriConf.csloutput == 'undefined' ) ? 'bibliography' : uriConf.csloutput;
    //config.cslOutput = (typeof uriConf.csloutput == 'undefined' ) ? 'bibliography' : uriConf.csloutput;
    return config;
}

http.createServer(function (request, response) {
    //zcreq keeps track of information about this request and is passed around
    var zcreq = {};
    zcite.debug("request received", 5);
    if(request.method == "OPTIONS"){
        zcite.debug("options request received", 5);
        var nowdate = new Date();
        response.writeHead(200, {
            'Date': nowdate.toUTCString(),
            'Allow': 'POST,OPTIONS',
            'Content-Length': 0,
            'Content-Type': 'text/plain',
        });
        response.end('');
        return;
    }
    else if(request.method != "POST"){
        response.writeHead(400, {'Content-Type': 'text/plain'});
        response.end("Item data must be POSTed with request");
        return;
    }
    request.setEncoding('utf8');
    request.on('data', function(data){
        if(typeof this.POSTDATA === "undefined"){
            this.POSTDATA = data;
        }
        else{
            this.POSTDATA += data;
        }
    });
    request.on('end', function(){
        try{
            zcite.debug('full request received', 5);
            //parse url from request object
            var uriObj = url.parse(this.url);
            uriObj.parsedQuery = require('querystring').parse(uriObj.query);
            zcite.debug(uriObj, 5);
            //make config obj based on query
            var config = zcite.configureRequest(uriObj.parsedQuery);
            zcite.debug(JSON.stringify(config), 4);
            zcreq.config = config;
            //need to keep response in zcreq so async calls stay tied to a request
            zcreq.response = response;
            try{
                var postObj = JSON.parse(this.POSTDATA);
                zcreq.postObj = postObj;
            }
            catch(err){
                response.writeHead(400, {'Content-Type': 'text/plain'});
                response.end("Could not parse POSTed data");
                return;
            }
            
            //get items object for this request from post body
            var reqItemIDs;
            var reqItems = postObj.items;
            var reqItemsObj = {};
            if(typeof postObj.itemIDs != 'undefined'){
                reqItemIDs = postObj.itemIDs;
            }
            else{
                reqItemIDs = [];
            }
            
            //push itemIDs onto array and id referenced object for updateItems and retrieveItem function
            //items can be passed in as an object with keys becoming IDs, but ordering will not be guarenteed
            if(reqItems instanceof Array){
                //console.log(reqItems);
                for(var i = 0; i < reqItems.length; i++){
                    reqItemsObj[reqItems[i]['id']] = reqItems[i];
                    if(typeof postObj.itemIDs == 'undefined'){
                        reqItemIDs.push(reqItems[i]['id']);
                    }
                }
            }
            else if(typeof zcreq.postObj.items == 'object'){
                reqItemsObj = postObj.items;
                for(var i in reqItemsObj){
                    if(reqItemsObj.hasOwnProperty(i)){
                        if(reqItemsObj[i].id != i){
                            throw "Item ID did not match Object index";
                        }
                        reqItemIDs.push(i);
                    }
                }
            }
            
            //add citeproc required functions to zcreq object so it can be passed into CSL.Engine constructor
            zcreq.retrieveLocale = global.zcite.retrieveLocale;
            zcreq.retrieveItem = function(itemID){return this.items[itemID];};
            
            zcreq.reqItemIDs = reqItemIDs;
            zcreq.reqItemsObj = reqItemsObj;
            
            if(config.citations == '1'){
                zcreq.citationClusters = zcreq.postObj.citationClusters;
            }
            
            //make style identifier so we can check caches for real
            //check for citeproc engine cached
            //otherwise check for cached style
            //-initialize 
            Step(
                function fetchStyleIdentifier(){
                    //put the passed styleUrl into a standard form (adding www.zotero.org to short names)
                    zcite.debug("request step: fetchStyleIdentifier", 5);
                    //console.log(zcreq);
                    zcreq.styleUrlObj = zcite.cslFetcher.processStyleIdentifier(zcreq.config.style);
                    zcite.cslFetcher.resolveStyle(zcreq, this);
                    //return zcreq;
                },
                function tryCachedEngine(err, zcreq){
                    if(err){
                        zcite.debug("rethrowing error in tryCachedEngine");
                        throw err;
                    }
                    zcite.debug("request step: tryCachedEngine", 5);
                    //check for cached version or create new CSL Engine
                    var citeproc;
                    if(citeproc = zcite.cacheLoadEngine(zcreq.styleUrlObj.href, zcreq.config.locale)){
                        citeproc.sys.items = zcreq.reqItemsObj;
                        zcite.debug("citeproc.sys.items reset for zcreq", 5);
                        zcreq.citeproc = citeproc;
                    }
                    
                    return zcreq;
                },
                function fetchStyle(err, zcreq){
                    zcite.debug("request step: fetchStyle", 5);
                    if(err){
                        zcite.debug("rethrowing error in fetchStyle", 5);
                        throw err;
                    }
                    if(typeof zcreq.citeproc != 'undefined'){
                        //have cached engine, don't need csl xml
                        zcite.debug("already have citeproc : continuing", 5);
                        return zcreq;
                    }
                    var cslXml;
                    /*if(cslXml = zcite.cslFetcher.getCachedStyle(zcreq.styleUrlObj.href)){
                        //successfully fetched cached style - load engine and run request
                        zcreq.cslXml = cslXml;
                        return zcreq;
                    }
                    else{*/
                        zcite.cslFetcher.fetchStyle(zcreq, this);
                    //}
                },
                function createEngine(err, zcreq){
                    zcite.debug("request step: createEngine", 5);
                    if(err){
                        zcite.debug("rethrowing error in createEngine");
                        throw err;
                    }
                    //zcite.debug("cslXml: " + zcreq.cslXml, 5);
                    if(typeof zcreq.citeproc != 'undefined'){
                        //have cached engine, don't need csl xml
                        zcite.debug("still no cached engine", 5);
                        return zcreq;
                    }
                    zcite.createEngine(zcreq, this);
                },
                function runRequest(err, zcreq){
                    zcite.debug("request step: runRequest", 5);
                    if(err){
                        zcite.debug("rethrowing error in runRequest");
                        throw err;
                    }
                    //console.log(zcreq);
                    zcite.runRequest(zcreq, this);
                },
                function catchError(err, zcreq){
                    zcite.debug("request step: catchError", 5);
                    if(err) {
                        zcite.debug("error in Step", 5);
                        zcite.respondException(err, zcreq.response);
                    }
                    else{
                        zcite.debug("request step finished without apparent error", 5);
                    }
                }
            );
            
            
        }
        catch(err){
            if(typeof err == "string"){
                response.writeHead(500, {'Content-Type': 'text/plain'});
                response.end(err);
                return;
            }
            else{
                response.writeHead(500, {'Content-Type': 'text/plain'});
                response.end("An error occurred");
                return;
            }
        }
    });
    
    if(request.headers.expect == '100-continue'){
        zcite.debug("100-continue expected. writing header to response");
        response.writeHead(100);
    }
}).listen(zcite.config.listenport);

zcite.debug('Server running at http://127.0.0.1:' + zcite.config.listenport + '/', 1);

process.on('uncaughtException', function (err) {
    zcite.respondException(err, response);
});

