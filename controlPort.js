// A script for TorBrowser that provides a simple socket client for Tor's ControlPort.
//
// This file is written in call stack order (later functions
// call earlier functions). The file can be processed
// with docco.js to produce pretty documentation.

/* jshint moz: true */
/* jshint -W097*/
/* global Components, console */
"use strict";

// ### Mozilla Abbreviations
var {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu } = Components;

// ## io
// I/O utilities namespace
var io = io || {};

// __io.asyncSocket(host, port, onInputData)__.
// Creates an asynchronous, text-oriented TCP socket at host:port.
// The onInputData callback should accept a single argument, which will be called
// repeatedly, whenever incoming text arrives. Returns a socket object with two methods:
// socket.write(text) and socket.close().
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
      // Create an "input stream pump" that takes an input stream and asynchronously
      // pumps incoming data to a "stream listener."
      pump = Cc["@mozilla.org/network/input-stream-pump;1"]
               .createInstance(Components.interfaces.nsIInputStreamPump);
    // Start the pump.
    pump.init(inputStream, -1, -1, 0, 0, true);
    // Tell the pump to read all data whenever it is available, and pass the data
    // to the onInputData callback. The first argument to asyncRead implements
    // nsIStreamListener. 
    pump.asyncRead({ onStartRequest: function (request, context) { },
                     onStopRequest: function (request, context, code) { },
                     onDataAvailable : function (request, context, stream, offset, count) {
                       onInputData(readAll());    
                     } }, null);
  return { // Write a message to the socket.
           write : function(aString) {
             outputStream.write(aString, aString.length);
           },
           // Close the socket.
           close : function () {
             // Close all stream objects.
             scriptableInputStream.close();
             inputStream.close();
             outputStream.close();
           } };
};
           
// __io.onDataFromOnLine(onLine)__.
// Converts a callback that expects incoming individual lines of text to a callback that
// expects incoming raw socket string data.
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
    // Call onLine for all completed lines.
    lines.slice(0,-1).forEach(onLine);
  };
};

// __io.callbackDispatcher()__.
// Returns [onString, dispatcher] where the latter is an object with two member functions:
// dispatcher.addCallback(regex, callback), and dispatcher.removeCallback(callback).
// Pass onString to another function that needs a callback with a single string argument.
// Whenever dispatcher.onString receives a string, the dispatcher will check for any
// regex matches and pass the string on to the corresponding callback(s).
io.callbackDispatcher = function () {
  var callbackPairs = [],
      removeCallback = function (aCallback) {
        callbackPairs = callbackPairs.filter(function ([regex, callback]) {
          return callback !== aCallback;
        });
      },
      addCallback = function (regex, callback) {
        if (callback) {
          callbackPairs.push([regex, callback]);
        }
        return function () { removeCallback(callback); };
      },
      onString = function (message) {
        for (let [regex, callback] of callbackPairs) {
          if (message.match(regex)) {
            callback(message);
          } 
        }
      };
  return [onString, {addCallback : addCallback, removeCallback : removeCallback}];
};

// __io.interleaveCommandsAndReplies(asyncSend)__.
// Takes asyncSend(message), an asynchronous send function, and returns two functions
// sendCommand(command, replyCallback) and onReply(response). Ensures that asyncSend will
// be called only after we have received a response to the previous asyncSend call through onReply.
io.interleaveCommandsAndReplies = function (asyncSend) {
  var commandQueue = [],
      sendCommand = function (command, replyCallback) {
        commandQueue.push([command, replyCallback]);
        if (commandQueue.length == 1) {
          // No pending replies; send command immediately.
          asyncSend(command);
        }
      },
      onReply = function (reply) {
        var [command, replyCallback] = commandQueue.shift();
        if (replyCallback) { replyCallback(reply); }
        if (commandQueue.length > 0) {
          var [nextCommand, nextReplyCallback] = commandQueue[0];
          asyncSend(nextCommand);
        }
      };  
  return [sendCommand, onReply];
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
    if (line.match(/^\d\d\d /) && (pendingLines.length == 1 ||
                                   pendingLines[0].startsWith(line.substring(0,3)))) {
      onMessage(pendingLines.join("\r\n"));
      // Get ready for the next message.
      pendingLines = [];
    }
  };
};

// __tor.controlSocket(host, port, notificationCallback)__.
// Instantiates a tor control socket at host:port. Asynchronous "650" notifications
// strings will be sent to the notificationCallback(text) function. Returns a socket object
// with methods socket.close() and socket.sendCommand(command, replyCallback).
tor.controlSocket = function (host, port, notificationCallback) {
  var [onMessage, dispatcher] = io.callbackDispatcher(),
      socket = io.asyncSocket(host, port,
                              io.onDataFromOnLine(tor.onLineFromOnMessage(onMessage))),    
      writeLine = function (text) { socket.write(text + "\r\n"); },
      [sendCommand, onReply] = io.interleaveCommandsAndReplies(writeLine);
  dispatcher.addCallback(/^[245]\d\d/, onReply); 
  dispatcher.addCallback(/^650/, notificationCallback);
  sendCommand("authenticate", console.log);
  sendCommand("setevents stream circ", console.log);
  return { close : socket.close, sendCommand : sendCommand };
};
