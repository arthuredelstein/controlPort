var socketTransportService = Components.classes["@mozilla.org/network/socket-transport-service;1"].getService(Components.interfaces.nsISocketTransportService);
var ScriptableInputStream = Components.Constructor("@mozilla.org/scriptableinputstream;1", "nsIScriptableInputStream", "init");
var socket = socketTransportService.createTransport(null, 0, m_tb_control_host, m_tb_control_port, null);
var input = socket.openInputStream(2, 1, 1).QueryInterface(Ci.nsIAsyncInputStream);
var scriptableInput = new ScriptableInputStream(input);
var output = socket.openOutputStream(2, 1, 1);
var write = function(aString) { output.write(aString, aString.length); };
var writeLine = function(lineString) { write(lineString + "\r\n"); };
var readAll = function() { return scriptableInput.read(scriptableInput.available()); };

var pump = Components.classes["@mozilla.org/network/input-stream-pump;1"]
                     .createInstance(Components.interfaces.nsIInputStreamPump);
pump.init(input, -1, -1, 0, 0, true);
pump.asyncRead({ onStartRequest: function (request, context) { },
                 onStopRequest: function (request, context, code) { },
                 onDataAvailable : function( request, context, stream, offset, count) {
                  console.log(readAll());    
               }}, null);