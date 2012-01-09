// jslint.js lib/piped.js --nomen --plusplus --white --node //

// ******************************************************************
// Pipe or Send?
// ******************************************************************
//
// Stream objects (tcp/socket) can be piped to other stream objects,
// using the builtin .pipe() method. If it's not a stream object on
// input OR output, we have to do writes ourselves. This is true
// whenever an UDP socket is involved. See below diagram:
//
// Input   Output      Pipe?
//
// Socket  Socket      V
// Socket  TCP         V
// Socket  UDP         -
// TCP     Socket      V
// TCP     TCP         V
// TCP     UDP         -
// UDP     Socket      -
// UDP     TCP         -
// UDP     UDP         -
//
// ******************************************************************

// ******************************************************************
// Module flow
// ******************************************************************
//
//  * Set up remote connections
//      * for all servers call _connect_to_server:
//          * For UDP, call:           RemoteUPDConnect
//          * For TCP or Socket, call: RemoteStreamConnect
//
//  * Set up Management Server
//      * Callback to ___admin_command
//
//  * Set up Listeners
//      * For UDP, call:            LocalUDPListen
//      * For TCP & Socket, call:   LocalStreamListen
//      *
//      * On connection call _available_server
//          * If tcp/socket to tcp/socket, set pipe
//          * else, write to socket manually
//
//  * Manage unavailable servers
//      * Set to 'unavailable' in _available_server call
//      * Periodic job calls _connect_to_server on unavailable servers
//
// ******************************************************************

// strict parsing
"use strict";

// *********************************
// Libraries
// *********************************

var Net     = require('net');
var U       = require('util');
var Dgram   = require("dgram");

// ****************************************
// Utility functions
// ****************************************

function _now ()         { return Math.round( new Date().getTime() / 1000 ) }
function _json_pp (data) { return JSON.stringify( data , null, 2 )          }

// *********************************
// State / Config / Stats vars
// *********************************

// Global state
var Config = {
    // TODO: support sockets/udp
    unix_socket:            '/tmp/piped.socket',
    udp_port:               1338,
    encoding:               'ascii',
    debug:                  true,
    trace:                  true,
    tcp_port:               1337,
    bind_address:           '127.0.0.1',
    admin_port:             1338,
    admin_bind_address:     '127.0.0.1',
    reconnect_interval:     1000,           // in ms
    servers:                [ //"tcp://localhost:10001",
                              //"tcp://localhost:10002",
                              "/tmp/echo1.socket",
                              "udp://localhost:10005",
                            ],
};

// Statistics
var Stats = {
    connections: {
        admin:  0,
        tcp:    0,
        udp:    0,
        socket: 0,
        total:  0,
        last:   0,
        idle:   0,
    },
    start_time: _now(),
    uptime: 0,
};

var State = {
    // will be 'server:port' => server object (see ___remote_*_connect)
    servers:    { },
};


// ****************************************
// Remote connection object
// ****************************************

// UDP
function RemoteUDPConnect ( name, host, port ) {
    this.connection = Dgram.createSocket("udp4");
    this.name       = name;

    // scope issues? 'this' doesn't appear to be available
    // in the function, even though it should be in scope.
    // very confusing.
    var obj         = this;

    // invoked whenever we get data from a remote source
    this.send       = function( data ) {
                        var buf = new Buffer( data );

                        // if encoding is ascii, we're getting an extra
                        // char (\n) at the end of data. Dgram adds one
                        // more \r\n when sending it on. So, we should
                        // remove the newline character from the end of
                        // the string before sending it on:
                        var len = Config.encoding === 'ascii'
                                    ? buf.length - 1
                                    : buf.length;

                        obj.connection.send( buf, 0, len, port, host,
                            // XXX improve me
                            function ( err, bytes ) { U.log( bytes ) } );
                      };

    // UDP sockets are always available, mark them available by default
    // we'll use the callback to find out what's going on
    this.mark_available();
}
RemoteUDPConnect.prototype              = new _RemoteConnect();
RemoteUDPConnect.prototype.constructor  = RemoteUDPConnect;


// TCP & Socket
function RemoteStreamConnect ( name, host, port ) {
    // host might just be a unix socket, it works transparently
    this.connection = Net.createConnection( port, host );

    // set to true, meaning we can use piping
    this.is_stream  = true;
    this.name       = name;

    // scope issues? 'this' doesn't appear to be available
    // in the function, even though it should be in scope.
    // very confusing.
    var obj         = this;

    // Ideally, we're being piped to. But if not, here's our
    // manual way of sending data
    this.send       = function( data ) { obj.connection.write( data ) },

    // we connected? -- this won't get triggered for UDP, so we
    // set it explicitly in the TCP connection code
    this.connection.on( 'connect', function( listener ) {
        U.log( U.format( "Connected to %s", name ) );

        // server is now ready for use
        obj.mark_available();
    });

    // Some error happened?
    this.connection.on( 'error', function (e) {

        // this can get very chatty, so hide it behind trace
        if( Config.trace ) {
            U.error( U.format( "ERROR: %s: %s", obj.name, e ) );
        }

        // mark the server as no longer available
        obj.mark_unavailable();
    });
}
RemoteStreamConnect.prototype               = new _RemoteConnect();
RemoteStreamConnect.prototype.constructor   = RemoteStreamConnect;

// Base object
function _RemoteConnect () {
    this.is_available   = false;
    this.state_changed  = _now();
    this.state_changes  = 0;
    this.last_sent      = false;

    // needs to be filled in by parent
    this.name           = false;
    this.send           = false;
    this.connection     = false;
    this.is_stream      = false;

    // scope issues? 'this' doesn't appear to be available
    // in the function, even though it should be in scope.
    // very confusing.
    var obj             = this;

    this.mark_available     = function () {
        // mark the server as available
        obj.is_available    = true;
        obj.state_changed   = _now();
        obj.state_changes++;
    }

    this.mark_unavailable   = function () {
        // mark the server as no longer available
        obj.is_available    = false;
        obj.state_changed   = _now();
        obj.state_changes++;
    }

    this.incr_stats = function () {
        obj.last_sent   = _now();
    };

    this.stats = function () {
        return {
            available:      obj.is_available,
            last_sent:      obj.last_sent,
            state_changes:  obj.state_changes,
            state_changed:  (_now() - obj.state_changed),
            // If nothing was ever sent, the idle time == uptime
            idle:           (obj.last_sent ? (_now() - obj.last_sent) : Stats.uptime),
        };
    };

}



// ****************************************
// Remote connection code
// ****************************************

function _connect_to_server( str, reconnect ) {
    var pre   = reconnect ? "RE-" : "";

    if( Config.trace ) {
        U.debug( U.format( "%sConnecting to remote %s", pre, str ) );
    }

    // *********************************
    // Interfaces REMOTES listen on
    // *********************************

    var remote = (function( str ) {
        // socket
        var m = str.match(/^\/.+?/);
        if( m && m[0] ) {
            return new RemoteStreamConnect( str, str, str )
        }

        // udp or tcp server
        //                  type :// host : port
        var n = str.match(/^(\w+):\/\/(.+?):(\d+)$/);
        if( n && n[0] ) {

            // tcp
            if ( n[1] === 'tcp' ) {
                return new RemoteStreamConnect( str, n[2], n[3] );
            // udp
            } else if( n[1] === 'udp' ) {
                return new RemoteUDPConnect( str, n[2], n[3] );

            // garbage
            } else {
                throw( U.format( "Unknown server type '%s'", n[1] ) );
            }
        }

        // if we get here, we don't know the format
        throw( U.format( "Can not parse connection string '%s'", str ) );

    }( str ));

    return remote;
}

// ****************************************
// Local listener object
// ****************************************

// TCP & Socket - 'host' may just be a local socket
function LocalStreamListen (type, port, ip) {

    // is_stream == true means we can use pipes if the
    // receiving server is a stream as well.
    this.is_stream  = true;
    this.port       = port;
    this.ip         = ip;
    this.type       = type.toLowerCase();

    // set up the handler
    this.connection = Net.createServer();

    // scope issues? 'this' doesn't appear to be available
    // in the function, even though it should be in scope.
    // very confusing.
    var obj         = this;

    // simple diagnostic sub to show we're listening
    this.connection.on( 'listening', function() { obj.on_listen( obj ) } );

    this.connection.on( 'connection', function( conn ) {
        var remote = _available_server( State.servers );

        // bookkeeping
        obj.incr_stats( obj );
        remote.incr_stats( remote );

        // 2 streams, we can pipe that
        if( remote.is_stream ) {
            if( Config.trace ) {
                U.debug( U.format( "Piping to %s", remote.name ) );
            }

            conn.pipe( remote.connection, { end: false } );

        // fallback to sending the data ourselves
        } else {
            if( Config.trace ) {
                U.debug( U.format( "Manual send to %s", remote.name ) );
            }

            conn.on( 'data', function (data) {
                remote.send( data );
                remote.last_send = _now();
            });
        }
    });

    if( Config.trace ) {
        U.debug( U.format( "Opening %s connection on %s:%s", type, ip, port ) );
    }

    this.connection.listen( port, ip );
}
LocalStreamListen.prototype               = new _LocalListen();
LocalStreamListen.prototype.constructor   = LocalStreamListen;

// UDP
function LocalUDPListen ( type, port, ip) {
    this.connection = Dgram.createSocket("udp4");
    this.port       = port;
    this.ip         = ip;
    this.type       = type;

    // scope issues? 'this' doesn't appear to be available
    // in the function, even though it should be in scope.
    // very confusing.
    var obj         = this;

    // simple diagnostic sub to show we're listening
    this.connection.on( 'listening', function () { obj.on_listen( obj ) } );

    // It's coming in over UDP, so no chance to pipe
    this.connection.on( 'message', function (data, rinfo) {

        // bookkeeping
        obj.incr_stats( obj );
        remote.incr_stats( remote );

        remote.send( data );
    });

    if( Config.trace ) {
        U.debug( U.format( "Opening %s socket on %s", type, ip, port ) );
    }

    this.connection.bind( port, ip );
}
LocalUDPListen.prototype               = new _LocalListen();
LocalUDPListen.prototype.constructor   = LocalUDPListen;

function _LocalListen () {
    this.on_listen  = function (obj) {
        var addr = obj.connection.address();

        // some sort of port is in use
        if( addr.address ) {
            U.log( U.format( "%s Server started on %s:%s",
                obj.type, addr.address, addr.port ) );

        // it's a local socket
        } else {
            U.log( U.format( "Unix Socket Server started on %s", obj.port ) );
        }
    };

    this.incr_stats = function (obj) {
        Stats.connections[ obj.type ]++;
        Stats.connections.total++;
        Stats.connections.last = _now();
    };

    //this.send       = function() { };

    // set by parent
    this.ip         = false;
    this.port       = false;
    this.connection = false;
    this.is_stream  = false;
}

// ****************************************
// Find available servers
// ****************************************

function _available_server (servers) {
    // where to send it? scan the list for available servers

    // scan every time, so we don't send to a host that's been
    // down for a while, and immediately send to a recovered host.

    var idx;
    for( idx in servers ) {
        var remote = servers[idx];
        var name   = remote.name

        if( Config.debug ) {
            U.debug( U.format( "Attempting to use '%s'", name ) );
        }

        // already marked as down
        if( remote.is_available === false ) {
            continue;

        // potential socket, but check if it's not been destroyed
        // this happens if the remote end disappears, which means
        // we should mark it for reconnect
        } else if ( remote.connection.destroyed ) {
            U.error( U.format( "Server %s unavailable - marking for reconnect", name ) );
            remote.mark_unavailable();
            continue;

        } else {
            // XXX can we detect a write failure? returning false
            // here means it was queued in user memory, not that
            // the socket has gone away.
            return remote;
        }
    }

    // if we got here, we couldn't send the message
    U.error( U.format( "No available servers" ) );

    return false;

}

// *********************************
// Send data to remote server
// *********************************

function ___remote_send (data, type, stream) {
    Stats.connections[type]++;
    Stats.connections.total++;
    Stats.connections.last = _now();

    var remote = _available_server( State.servers );

    remote.write( data );
    remote.last_send = _now();


    if( stream !== undefined ) {
        stream.write( U.format( "You sent %s\n", data ) );
    }
}

// *********************************
// Admin commands
// *********************************

function ___admin_command( cmd) {

    if( Config.debug ) {
        U.debug( "Got admin command: " + cmd );
    }

    // Recompute uptime
    Stats.uptime            = _now() - Stats.start_time;

    // Recompute idle time - if we don't have a last item, idle time == uptime
    Stats.connections.idle  = Stats.connections.last
                                ? _now() - Stats.connections.last
                                : Stats.uptime;

    switch(cmd) {
        case "stats":
            var idx;
            var map = { };

            // Map state to something consumable by a client
            for( idx in State.servers ) {
                map[ State.servers[idx].name ] = State.servers[idx].stats();
            }

            // return that and stats back
            return _json_pp( { stats: Stats, servers: map } );

        case "ping":
            return "pong";

        case "logrotate":
            return "TODO";

        case "dump":
            U.debug( U.inspect( State ) );


        default:
            return "ERROR\n";
    }
}

// *********************************
// Setup code
// *********************************

(function () {

    // *********************************
    // TCP server
    // *********************************

    if( Config.tcp_port ) {
        new LocalStreamListen( 'tcp', Config.tcp_port, Config.bind_address );
    }

    // *********************************
    // Unix socket
    // *********************************

    if( Config.unix_socket ) {
        new LocalStreamListen( 'unix', Config.unix_socket );
    }


    // *********************************
    // UDP server
    // *********************************

    if( Config.udp_port ) {
        new LocalUDPListen( 'udp', Config.udp_port, Config.bind_address );
    }

    // *********************************
    // Admin server
    // *********************************

    (function () {
        // This server processes any admin commands, change of config, stats
        var AdminServer = Net.createServer(function (stream) {
            stream.setEncoding('ascii');

            stream.on( 'data', function (data) {
                Stats.connections.admin++;

                var cmd = data.trim();

                stream.write( ___admin_command( cmd ) );
            });

            //stream.write( U.inspect( State ) );
            //stream.write( U.inspect( Stats ) );
            //stream.write( U.inspect( State.servers[0] ) );
            //stream.write( U.inspect( State.servers[1] ) );
            //stream.write( U.inspect( ) );
            //stream.write( U.inspect( ) );
        });

        AdminServer.listen( Config.admin_port, Config.admin_bind_address );

        U.log( U.format( "Admin Server started on %s:%s",
                    Config.admin_bind_address, Config.admin_port ) );
    }());

    // ****************************************
    // Connect to remote servers
    // ****************************************

    // initial connect
    (function() {
        var idx;
        for( idx in Config.servers ) {
            var name = Config.servers[idx];

            // not yet connected
            if( State.servers[name] == undefined ) {

                State.servers[name] = _connect_to_server( name );
            }
        }
    }());

    // Reconnect if needed
    (function() {
        var reconnectInt = setInterval( function () {

            //U.debug( U.inspect( State ) );
            var idx;
            for( idx in State.servers ) {

                // server currently unavailable
                if( State.servers[idx].is_available === false ) {

                    // get the name
                    var name = State.servers[idx].name;

                    // and reconnect
                    State.servers[idx] = _connect_to_server( name, true );
                }
            }
        }, Config.reconnect_interval );
    }());

}());
