// A module for TorBrowser that provides an asynchronous controller for
// Tor, through its ControlPort.
//
// This file is written in call stack order (later functions
// call earlier functions). The file can be processed
// with docco.js to produce pretty documentation.
//
// To import the module, use
//
//     let { controller } = Components.utils.import("path/to/controlPort.jsm");
//
// See the last function defined in this file, controller(host, port, password, onError)
// for usage of the controller function.

/* jshint moz: true */
/* jshint -W097 */
/* global Components, console */
"use strict";

// ### Mozilla Abbreviations
let {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu } = Components;

// ## io
// I/O utilities namespace
let io = io || {};

// __io.asyncSocketStreams(host, port)__.
// Creates a pair of asynchronous input and output streams for a socket at the
// given host and port.
io.asyncSocketStreams = function (host, port) {
  let socketTransportService = Cc["@mozilla.org/network/socket-transport-service;1"]
           .getService(Components.interfaces.nsISocketTransportService),
       // Create an instance of a socket transport.
      socketTransport = socketTransportService.createTransport(null, 0, host, port, null),
      // Open asynchronous outputStream and inputStream.
      outputStream = socketTransport.openOutputStream(2, 1, 1),
      inputStream = socketTransport.openInputStream(2, 1, 1)
                      .QueryInterface(Ci.nsIAsyncInputStream);
  return [inputStream, outputStream];  
};

// __io.pumpInputStream(scriptableInputStream, onInputData, onError)__.
// Run an "input stream pump" that takes an input stream and
// asynchronously pumps incoming data to the onInputData callback.
io.pumpInputStream = function (inputStream, onInputData, onError) {
  // Wrap raw inputStream with a "ScriptableInputStream" so we can read incoming data.
  let ScriptableInputStream = CC("@mozilla.org/scriptableinputstream;1",
           "nsIScriptableInputStream", "init"),
      scriptableInputStream = new ScriptableInputStream(inputStream),
      // A private method to read all data available on the input stream.
      readAll = function() {
        return scriptableInputStream.read(scriptableInputStream.available());
      },  
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
                     try {
                       onInputData(readAll());
                     } catch (error) {
                       // readAll() or onInputData(...) has thrown an error.
                       // Notify calling code through onError.
                       onError(error);
                     }
                   } }, null);
};

// __io.asyncSocket(host, port, onInputData, onError)__.
// Creates an asynchronous, text-oriented TCP socket at host:port.
// The onInputData callback should accept a single argument, which will be called
// repeatedly, whenever incoming text arrives. Returns a socket object with two methods:
// socket.write(text) and socket.close(). onError will be passed the error object
// whenever a write fails.
io.asyncSocket = function (host, port, onInputData, onError) {
  let [inputStream, outputStream] = io.asyncSocketStreams(host, port);
  // Run an input stream pump to send incoming data to the onInputData callback.
  io.pumpInputStream(inputStream, onInputData, onError);
  return { 
           // Write a message to the socket.
           write : function(aString) {
             try {
               outputStream.write(aString, aString.length);
             } catch (err) {
               // This write() method is not necessarily called by a callback,
               // but we pass any thrown errors to onError to ensure the socket
               // error handling uses a consistent single path.
               onError(err);
             }
           },
           // Close the socket.
           close : function () {
             // Close stream objects.
             inputStream.close();
             outputStream.close();
           }
         };
};
           
// __io.onDataFromOnLine(onLine)__.
// Converts a callback that expects incoming individual lines of text to a callback that
// expects incoming raw socket string data.
io.onDataFromOnLine = function (onLine) {
  // A private variable that stores the last unfinished line.
  let pendingData = "";
  // Return a callback to be passed to io.asyncSocket. First, splits data into lines of 
  // text. If the incoming data is not terminated by CRLF, then the last
  // unfinished line will be stored in pendingData, to be prepended to the data in the
  // next call to onData. The already complete lines of text are then passed in sequence
  // to onLine.
  return function (data) {
    let totalData = pendingData + data,
        lines = totalData.split("\r\n"),
        n = lines.length;
    pendingData = lines[n - 1];
    // Call onLine for all completed lines.
    lines.slice(0,-1).map(onLine);
  };
};

// __io.callbackDispatcher()__.
// Returns [onString, dispatcher] where the latter is an object with two member functions:
// dispatcher.addCallback(regex, callback), and dispatcher.removeCallback(callback).
// Pass onString to another function that needs a callback with a single string argument.
// Whenever dispatcher.onString receives a string, the dispatcher will check for any
// regex matches and pass the string on to the corresponding callback(s).
io.callbackDispatcher = function () {
  let callbackPairs = [],
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

// __io.matchRepliesToCommands(asyncSend)__.
// Takes asyncSend(message), an asynchronous send function, and returns two functions
// sendCommand(command, replyCallback) and onReply(response). If we call sendCommand,
// then when onReply is called, the corresponding replyCallback will be called.
io.matchRepliesToCommands = function (asyncSend) {
  let commandQueue = [],
      sendCommand = function (command, replyCallback) {
        commandQueue.push([command, replyCallback]);
        asyncSend(command);
      },
      onReply = function (reply) {
        let [command, replyCallback] = commandQueue.shift();
        if (replyCallback) { replyCallback(reply); }
      };
      onFailure = function () {
        commandQueue.shift();
      };
  return [sendCommand, onReply, onFailure];
};

// __io.onLineFromOnMessage(onMessage)__.
// Converts a callback that expects incoming control port multiline message strings to a
// callback that expects individual lines.
io.onLineFromOnMessage = function (onMessage) {
  // A private variable that stores the last unfinished line.
  let pendingLines = [];
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

// __io.controlSocket(host, port, password, onError)__.
// Instantiates and returns a socket to a tor ControlPort at host:port,
// authenticating with the given password. onError is called with an
// error object as its single argument whenever an error occurs. Example:
//
//     // Open the socket
//     let socket = controlSocket("127.0.0.1", 9151, "MyPassw0rd",
//                    function (error) { console.log(error.message || error); });
//     // Send command and receive "250" reply or error message
//     socket.sendCommand(commandText, replyCallback);
//     // Register or deregister for "650" notifications
//     // that match regex
//     socket.addNotificationCallback(regex, callback);
//     socket.removeNotificationCallback(callback);
//     // Close the socket permanently
//     socket.close();
io.controlSocket = function (host, port, password, onError) {
  // Produce a callback dispatcher for Tor messages.
  let [onMessage, mainDispatcher] = io.callbackDispatcher(),
      // Open the socket and convert format to Tor messages.
      socket = io.asyncSocket(host, port,
                              io.onDataFromOnLine(io.onLineFromOnMessage(onMessage)),
                              onError),
      // Tor expects any commands to be terminated by CRLF.
      writeLine = function (text) { socket.write(text + "\r\n"); },
      // Ensure we return the correct reply for each sendCommand.
      [sendCommand, onReply, onFailure] = io.matchRepliesToCommands(writeLine),
      // Create a secondary callback dispatcher for Tor notification messages.
      [onNotification, notificationDispatcher] = io.callbackDispatcher();
  // Pass successful reply back to sendCommand callback.
  mainDispatcher.addCallback(/^2\d\d/, onReply); 
  // Pass error message to sendCommand callback.
  mainDispatcher.addCallback(/^[45]\d\d/, function (message) {
    onFailure();
    onError(new Error(message));
  });
  // Pass asynchronous notifications to notification dispatcher.
  mainDispatcher.addCallback(/^650/, onNotification);
  // Log in to control port.
  sendCommand("authenticate " + password); // , console.log);
  // Activate needed events.
  sendCommand("setevents stream circ"); // , console.log);
  return { close : socket.close, sendCommand : sendCommand,
           addNotificationCallback : notificationDispatcher.addCallback,
           removeNotificationCallback : notificationDispatcher.removeCallback };
};

// ## utils
// A namespace for utility functions
let utils = utils || {};

// __utils.capture(string, regex)__.
// Takes a string and returns an array of capture items, where regex must have a single
// capturing group and use the suffix /.../g to specify a global search.
utils.capture = function (string, regex) {
  let matches = [];
  // Special trick to use string.replace for capturing multiple matches.
  string.replace(regex, function (a, captured) {
    matches.push(captured);
  });
  return matches;
};

// __utils.extractor(regex)__.
// Returns a function that takes a string and returns an array of regex matches. The
// regex must use the suffix /.../g to specify a global search.
utils.extractor = function (regex) {
  return function (text) {
    return utils.capture(text, regex);
  };
};

// __utils.splitAtSpaces(string)__.
// Splits a string into chunks between spaces. Does not split at spaces
// inside pairs of quotation marks.
utils.splitAtSpaces = utils.extractor(/((\S*?"(.*?)")+\S*|\S+)/g);

// __utils.splitAtEquals(string)__.
// Splits a string into chunks between equals. Does not split at equals
// inside pairs of quotation marks.
utils.splitAtEquals = utils.extractor(/(([^=]*?"(.*?)")+[^=]*|[^=]+)/g);

// __utils.pairsToMap(pairs)__.
// Convert a series of pairs [[a1, b1], [a2, b2], ...] to a map {a1 : b1, a2 : b2 ...}.
utils.pairsToMap = function (pairs) {
  let result = {};
  pairs.map(function ([a, b]) {
    result[a] = b;
  });
  return result;
};

// __utils.listMapData(parameterString)__.
// Takes a list of parameters separated by spaces, of which the first several are
// unnamed, and the remainder are named, in the form `NAME=VALUE`. Produces a vector
// with the unnamed parameters, ending with a map containing named parameters.
// Example:
//
//     utils.listMapData("40 FAILED 0 95.78.59.36:80 REASON=CANT_ATTACH");
//     // --> [ "40", "FAILED", "0", "95.78.59.36:80", {"REASON" : "CANT_ATTACH"} ]
utils.listMapData = function (parameterString) {
  let parameters = utils.splitAtSpaces(parameterString),
      dataMap = {},
      result = [];
  // Unnamed parameters go into list; named parameters go into map.
  for (let i = 0; i < parameters.length; ++i) {
    let [key, value] = utils.splitAtEquals(parameters[i]);
    if (key && value) {
      dataMap[key] = value;
    } else {
      result.push(parameters[i]);
    }
    if (Object.keys(dataMap).length > 0) {
      result.push(dataMap);
    }
  }
  return result;
};

// ## info
// A namespace for functions related to tor's GETINFO command.
let info = info || {};

// __info.keyValueStringsFromMessage(messageText)__.
// Takes a message (text) response to GETINFO and provides a series of key-value
// strings, which are either multiline (with a `250+` prefix):
//
//     250+config/defaults=
//     AccountingMax "0 bytes"
//     AllowDotExit "0"
//     .
//
// or single-line (with a `250-` prefix):
//
//     250-version=0.2.6.0-alpha-dev (git-b408125288ad6943)
info.keyValueStringsFromMessage = utils.extractor(/^(250\+[\s\S]+?^\.|250-.+?)$/gmi);

// __info.stringToKeyValuePair(string)__.
// Converts a key-value string to a key, value pair as from GETINFO. 
info.stringToKeyValuePair = function (string) {
  let key = string.match(/^250[\+-](.+?)=/mi)[1],
      matchResult = string.match(/250\-.+?=(.*?)$/mi) ||
                    string.match(/250\+.+?=([\s\S]*?)^\.$/mi),
      valueString = matchResult ? matchResult[1] : null;
  return [key, utils.listMapData(valueString)];
};

// __info.getInfoMultiple(controlSocket, keys, onMap)__.
// Requests info for an array of keys. Passes onMap a map of keys to values.
info.getInfoMultiple = function (controlSocket, keys, onMap) {
  controlSocket.sendCommand("getinfo " + keys.join(" "), function (message) {
    onMap(utils.pairsToMap(info.keyValueStringsFromMessage(message)
                               .map(info.stringToKeyValuePair)));
  });
};

// __info.getInfo(controlSocket, key, onValue)__.
// Requests info for a single key. Passes onValue the value for that key.
info.getInfo = function (controlSocket, key, onValue) {
  info.getInfoMultiple(controlSocket, [key], function (valueMap) {
    onValue(valueMap[key]);
  });
};

// ## event
// Handlers for events

let event = event || {};

// __event.messageToData(message)__.
// Extract the data from an event.
event.parameterString = function (message) {
  
  return message.match(/^650 \S+?\s(.*?)$/mi)[1];
};

// __event.watchEvent(controlSocket, type, filter, onData)__.
// Watches for a particular type of event. If filter(data) returns true, the event's
// data is pass to the onData callback.
event.watchEvent = function (controlSocket, type, filter, onData) {
  controlSocket.addNotification(new RegExp("^650 " + type), function (message) {
    let data = event.messageToData(message);
    if (filter(data)) {
      onData(data);
    }
  };
};

// ## tor
// Things related to the main controller.
let tor = tor || {};

// __tor.controller(host, port, password, onError)__.
// Creates a tor controller at the given host and port, with the given password.
// onError returns asynchronously whenever a connection error occurs.
tor.controller = function (host, port, password, onError) {
  let socket = io.controlSocket(host, port, password, onError);
  return { getInfo : function (key, log) { info.getInfo(socket, key, log); } ,
           getInfoMultiple : function (keys, log) {
             info.getInfoMultiple(socket, keys, log);
           },
           close : socket.close };
};

// __tor.controllerCache__.
// A map from "host:port" to controller objects. Prevents redundant instantiation
// of control sockets.
tor.controllerCache__ = {};

// ## Export

// __controller(host, port, password, onError)__.
// Instantiates and returns a controller object connected to a tor ControlPort
// at host:port, authenticating with the given password, if the controller doesn't yet
// exist. Otherwise returns the existing controller to the given host:port.
// onError is called with an error object as its single argument whenever
// an error occurs. Example:
//
//     // Get the controller
//     let c = controller("127.0.0.1", 9151, "MyPassw0rd",
//                    function (error) { console.log(error.message || error); });
//     // Send command and receive `250` reply or error message
//     c.getInfo("ip-to-country/16.16.16.16", console.log);
//     // Close the controller permanently
//     c.close();
let controller = function (host, port, password, onError) {
  let dest = host + ":" + port;
  return (tor.controller[dest] = tor.controller[dest] ||
          tor.controller(host, port, password, onError));
};

// Export the controller function for external use.
var EXPORTED_SYMBOLS = ["controller"];
