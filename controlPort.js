// A script for TorBrowser that provides a simple socket client for Tor's ControlPort.
//
// This file is written in call stack order (later functions
// call earlier functions). The code file can be processed
// with docco.js to provide clear documentation.

/* jshint moz: true */
/* jshint -W097*/
/* global Components */
// "use strict";

// ### Mozilla Abbreviations
var {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu } = Components;

// ## io
// I/O utilities namespace
var io = io || {};

// __io.asyncSocket(host, port, onInputData)__.
// Creates an asynchronous, text-oriented TCP socket at host:port.
// The onInputData callback should accept a single argument, which will be called
// repeatedly, whenever incoming text arrives. Returns a socket object with two methods:
// write(text) and close().
io.asyncSocket = function (host, port, onInputData) {
  // Load two Mozilla utilities.
  var socketTransportService = Cc["@mozilla.org/network/socket-transport-service;1"]
           .getService(Components.interfaces.nsISocketTransportService),
      ScriptableInputStream = CC("@mozilla.org/scriptableinputstream;1",
           "nsIScriptableInputStream", "init"),
       // Create an instance of a socket transport    
      socketTransport = socketTransportService.createTransport(null, 0, host, port, null),
      // Open asynchronous outputStream and inputStream.
      outputStream = socketTransport.openOutputStream(2, 1, 1),
      inputStream = socketTransport.openInputStream(2, 1, 1)
                      .QueryInterface(Ci.nsIAsyncInputStream),
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
                     onDataAvailable : function (request, context, stream, offset, count) {
                       onInputData(readAll());    
                     } }, null);
  return { // Wrap outputStream.write to make a single-argument write(text) method.
           write : function(aString) {
             outputStream.write(aString, aString.length);
           },
           // A close function that closes all stream objects.
           close : function () {
             scriptableInputStream.close();
             inputStream.close();
             outputStream.close();
           } };
};
           
// __io.onDataFromOnLine(onLine)__.
// Converts a callback that expects incoming individual lines of text to a callback that
// expects incoming raw socket data.
io.onDataFromOnLine = function (onLine) {
  // A private variable that stores the last unfinished line.
  var pendingData = "";
  // Return a callback to be passed to io.asyncSocket. First, splits data into lines of 
  // text. If the incoming data is not terminated by CRLF, then the last
  // unfinished line will be stored in pendingData, to be prepended to the data in the
  // next call to onData. The already complete lines of text are then passed in sequence
  // to onLine.
  return function (data) {
    var totalData = pendingData + data,
        lines = totalData.split("\r\n"),
        n = lines.length;
    pendingData = lines[n - 1];
    for (var i = 0; i < n - 1; ++i) {
      onLine(lines[i]);
    }
  }
};

// ## tor
// Namespace for tor-specific functions
var tor = tor || {};

// __tor.onLineFromOnMessage(onMessage)__.
// Converts a callback that expects incoming control port multiline message strings to a
// callback that expects individual lines.
tor.onLineFromOnMessage = function (onMessage) {
  // A private variable that stores the last unfinished line.
  var pendingLines = [];
  // Return a callback that expects individual lines.
  return function (line) {
    // Add to the list of pending lines.
    pendingLines.push(line);
    // If line is the last in a message, then pass on the full multiline message.
    if (line.match(/^\d\d\d /)) {
      onMessage(pendingLines.join("\r\n"));
      // Get ready for the next message.
      pendingLines = [];
    }
  }
};

// __tor.controPort__.
// Beginnings of the main control port factory.
tor.controlPort = function (host, port) {
  var onData = io.onDataFromOnLine(tor.onLineFromOnMessage(console.log)),
      socket = io.asyncSocket(host, port, onData),
      write = function (text) { socket.write(text + "\r\n"); };
  write("authenticate");
  //write("setevents circ stream");
  return { close : socket.close , write : write };
};

