// *********************************
// Libraries
// *********************************

var U               = require('util');
var Base            = require('./base');
var C               = require('./common');
var Configurator    = require('./configurator');
var LL              = require('./local_listen');


// *********************************
// Admin commands
// *********************************

function ___admin_command( cmd) {
    C._debug( "Got admin command: " + cmd );

    var stats   = this.stats_object();
    var state   = this.state_object();
    var config  = this.config_object();

    // Recompute uptime
    stats.uptime            = process.uptime();

    // Recompute idle time - if we don't have a last item, idle time == uptime
    stats.connections.idle  = stats.connections.last
                                ? C._now() - stats.connections.last
                                : stats.uptime;

    var out;
    try {
        switch(cmd) {
            // just in case /anything/ goes wrong.

//             case "stats":
//                 var idx;
//                 var map = { };
//                 var cur = [ ];
//
//                 // Map state to something consumable by a client
//                 for( idx in state.all_servers ) {
//                     map[ state.all_servers[idx].name ] = state.all_servers[idx].stats();
//                 }
//
//                 // List current active servers we are sending to
//                 for( idx = 0; idx < state.current_servers.length; idx++ ) {
//                     cur.push( state.current_servers[idx].name );
//                 }
//
//                 if( config.overflow_stream ) {
//                     map[ config.overflow_stream.name ] = config.overflow_stream.stats();
//                 }
//
//                 // return that and stats back
//                 return _json_pp({ stats: stats, active_servers: cur, all_servers: map });

            case "config":
                return C._json_pp( config );

//             case "__state":
//                 return U.inspect( state.current_servers );

            case "ping":
                return "pong";


            case "__dump":
                C._debug( state );
                return "OK";

            default:
                out = "ADMIN ERROR: UNKNOWN COMMAND " +  cmd + "\n";
                C._debug( out );
                return out;
        }
    } catch(e) {
        out = "ADMIN ERROR on '" + cmd + "': " + U.inspect( e );

        C._log( out );
        return out;
    }
}


// ****************************************
// Admin Server object
// ****************************************

var AdminServer = exports.AdminServer = function( port, address ) {
    C._debug( U.format( "Starting admin server on tcp://%s:%s", address, port ) );

    // On connection, dispatch to our callback
    new LL.LocalStreamListen( 'admin', port, address, function(ll, conn) {

        // These are line based commands
        conn.setEncoding('ascii');

        // Dispatch the command
        conn.on( 'data', function (data) {
            var cmd     = data.trim();

            conn.write( ___admin_command.bind( ll )( cmd ) );
        });
    });
}
