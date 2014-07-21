var {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu } = Components;

// __asyncSocket(host, port, onInputData)__.
// Creates an asynchronous, text-oriented TCP socket at host:port.
// The onInputData callback should accept a single argument, which will be called
// repeatedly, whenever incoming text arrives. Returns a socket object with two methods:
// write(text) and close().
var asyncSocket = function (host, port, onInputData) {
  // Load two Mozilla utilities.
  var socketTransportService = Cc["@mozilla.org/network/socket-transport-service;1"]
           .getService(Components.interfaces.nsISocketTransportService),
      ScriptableInputStream = CC("@mozilla.org/scriptableinputstream;1",
           "nsIScriptableInputStream", "init"),
       // Create an instance of a socket transport    
      socketTransport = socketTransportService.createTransport(null, 0, host, port, null),
      // Open asynchronous outputStream and inputStream.
      outputStream = socketTransport.openOutputStream(2, 1, 1),
      inputStream = socketTransport.openInputStream(2, 1, 1).QueryInterface(Ci.nsIAsyncInputStream),
      // Wrap inputStream with a "ScriptableInputStream" so we can read incoming data.
      scriptableInputStream = new ScriptableInputStream(inputStream),
      // A private method to read all data available on the socket.
      readAll = function() {
        return scriptableInputStream.read(scriptableInputStream.available());
      },
      // Creates an "input stream pump" that takes an input stream and asynchronously
      // pumps incoming data to an "stream listener".
      pump = Cc["@mozilla.org/network/input-stream-pump;1"]
               .createInstance(Components.interfaces.nsIInputStreamPump);
    // Start the pump.
    pump.init(inputStream, -1, -1, 0, 0, true);
    // Tell the pump to read all data whenever it is available, and pass the data
    // to the onInputData callback. The first argument to asyncRead is implementing
    // an nsIStreamListener. 
    pump.asyncRead({ onStartRequest: function (request, context) { },
                     onStopRequest: function (request, context, code) { },
                     onDataAvailable : function( request, context, stream, offset, count) {
                       onInputData(readAll());    
                     }}, null);
  return { 
           // Wrap outputStream.write to make a single-argument write(text) method.
           write : function(aString) {
             outputStream.write(aString, aString.length);
           },
           // A close function that closes all stream objects.
           close : function () {
             scriptableInputStream.close();
             inputStream.close();
             outputStream.close();
           }
         };
};
           
// __asyncLineSocket(host, port, onInputLine)__.
// Creates an asynchronous, text-line-oriented TCP socket at host:port.
// The onInputLine callback should accept a single argument, which will be called
// repeatedly, whenever a line of text arrives. Returns a socket object with two methods:
// write(textLine) and close(). The argument to the write method will be appended with
// CRLF before being sent to the socket.
var asyncLineSocket = function (host, port, onInputLine) {
  // A private variable that stores the last unfinished line.
  var pendingData = "";
  // A callback to be passed to asyncSocket. Splits data into lines of text, which are
  // passed to onInputLine. If the incoming data is not terminated by CRLF, then the last
  // unfinished line will be stored in pendingData, to be prepended to the data in the
  // next call to onData. The lines of text are then passed to onInputLine.
  var onData = function (data) {
        var totalData = pendingData + data,
            lines = totalData.split("\r\n"),
            n = lines.length;
        pendingData = lines[n - 1];
        for (var i = 0; i < n - 1; ++i) {
          onInputLine(lines[i]);
        }
      },
      // Generate the raw asynchronous socket.
      { write : dataWrite, close : close } = asyncSocket(host, port, onData),
      // Wrap the write function to ensure that argument is terminated with CRLF.
      write = function(lineString) { dataWrite(lineString + "\r\n"); };
  return { write : write, close : close };
};

