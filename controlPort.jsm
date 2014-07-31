// A script for TorBrowser that provides an asynchronous controller for
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

// __io.interleaveCommandsAndReplies(asyncSend)__.
// Takes asyncSend(message), an asynchronous send function, and returns two functions
// sendCommand(command, replyCallback) and onReply(response). Ensures that asyncSend will
// be called only after we have received a response to the previous asyncSend call through
// onReply.
io.interleaveCommandsAndReplies = function (asyncSend) {
  let commandQueue = [],
      sendCommand = function (command, replyCallback) {
        commandQueue.push([command, replyCallback]);
        if (commandQueue.length == 1) {
          // No pending replies; send command immediately.
          asyncSend(command);
        }
      },
      onReply = function (reply) {
        let [command, replyCallback] = commandQueue.shift();
        if (replyCallback) { replyCallback(reply); }
        if (commandQueue.length > 0) {
          let [nextCommand, nextReplyCallback] = commandQueue[0];
          asyncSend(nextCommand);
        }
      };  
  return [sendCommand, onReply];
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
      // Postpone command n+1 before we have received a reply to command n.
      [sendCommand, onReply] = io.interleaveCommandsAndReplies(writeLine),
      // Create a secondary callback dispatcher for Tor notification messages.
      [onNotification, notificationDispatcher] = io.callbackDispatcher();
  // Pass replies back to sendCommand callback.
  mainDispatcher.addCallback(/^[245]\d\d/, onReply); 
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

// __utils.identity(x)__.
// Returns its argument.
utils.identity = function (x) { return x; };

// __utils.asInt(x)__. Returns a decimal number in a string into a number.
utils.asInt = function (x) { return parseInt(x, 10); };

// __utils.pairsToMap(pairs)__.
// Convert a series of pairs [[a1, b1], [a2, b2], ...] to a map {a1 : b1, a2 : b2 ...}.
utils.pairsToMap = function (pairs) {
  let result = {};
  pairs.map(function ([a, b]) {
    result[a] = b;
  });
  return result;
};

// ## info
// A namespace for functions related to tor's GETINFO command.
let info = info || {};

// __info.kvStringsFromMessage(messageText)__.
// Takes a message (text) response to GETINFO and provides a series of key-value (KV)
// strings. KV strings are either multiline (with a `250+` prefix):
//
//     250+config/defaults=
//     AccountingMax "0 bytes"
//     AllowDotExit "0"
//     .
//
// or single-line (with a `250-` prefix):
//
//     250-version=0.2.6.0-alpha-dev (git-b408125288ad6943)
info.kvStringsFromMessage = utils.extractor(/^(250\+[\s\S]+?^\.|250-.+?)$/gmi);

// __info.stringToKV(kvString)__.
// Converts a key-value (KV) string to a key, value pair as from GETINFO. 
info.stringToKV = function (kvString) {
  let key = kvString.match(/^250[\+-](.+?)=/mi)[1],
      matchResult = kvString.match(/250\-.+?=(.*?)$/mi) ||
                    kvString.match(/250\+.+?=([\s\S]*?)^\.$/mi),
      value = matchResult ? matchResult[1] : null;
  return [key, value];
};

// __info.valueStringParsers__.
// Provides a function that parses the string response to a GETINFO request
// and converts it to JavaScript data.
info.valueStringParsers = {
  "version" : utils.identity,
  "config-file" : utils.identity,
  "config-defaults-file" : utils.identity,
  "config-text" : utils.identity,
  "exit-policy/" : "not supported",
  "desc/id/" : "not supported",
  "desc/name/" : "not supported",
  "md/id/" : "not supported",
  "md/name/" : "not supported",
  "dormant" : "not supported",
  "desc-annotations/id/" : "not supported",
  "extra-info/digest/" : "not supported",
  "ns/id/" : "not supported",
  "ns/name/" : "not supported",
  "ns/all/" : "not supported",
  "ns/purpose/" : "not supported",
  "desc/all-recent" : "not supported",
  "network-status" : "not supported",
  "address-mappings/" : "not supported",
  "addr-mappings/" : "deprecated",
  "address" : utils.identity,
  "fingerprint" : utils.identity,
  "circuit-status" : "not supported",
  "stream-status" : "not supported",
  "orconn-status" : "not supported",
  "entry-guards" : "not supported",
  "traffic/read" : utils.asInt,
  "traffic/written" : utils.asInt,
  "accounting/enabled" : function (x) { return x === "1"; },
  "accounting/hibernating" : utils.identity,
  "accounting/bytes" : "not supported",
  "accounting/bytes-left" : "not supported",
  "accounting/interval-start" : "not supported",
  "accounting/interval-wake" : "not supported",
  "accounting/interval-end" : "not supported",
  "config/names" : "not supported",
  "config/defaults" : "not supported",
  "info/names" : "not supported",
  "events/names" : "not supported",
  "features/names" : "not supported",
  "signal/names" : "not supported",
  "ip-to-country/" : utils.identity,
  "next-circuit/" : utils.identity,
  "process/" : utils.identity,
  "process/descriptor-limit" : utils.asInt,
  "dir/status-vote/current/consensus" : "not supported",
  "dir/status/" : "not supported",
  "dir/server/" : "not supported",
  "status/" : "not supported",
  "net/listeners/" : "not supported",
  "dir-usage" : "not supported"
};

// __info.getValueStringParser(key)__.
// Takes a key a determines the parser function that should be used to
// convert its corresponding valueString to JavaScript data.
info.getValueStringParser = function(key) {
  return info.valueStringParsers[key] ||
         info.valueStringParsers[key.substring(0, key.lastIndexOf("/") + 1)] ||
         "unknown";         
};

// __info.parseValueString([key, valueString])__
// Takes a [key, valueString] pair and converts it to useful data, appropriate to the key.
info.parseValueString = function ([key, valueString]) {
  return [key, info.getValueStringParser(key)(valueString)];
};

// __info.getInfoMultiple(controlSocket, keys, onMap)__.
// Requests info for an array of keys. Passes onMap a map of keys to values.
info.getInfoMultiple = function (controlSocket, keys, onMap) {
  for (let i in keys) {
    let parser = utils.getValueStringParser(keys[i]);
    if (parser instanceof String) {
      throw new Error(keys[i] + ": " + parser + ".");
    }
  }
  controlSocket.sendCommand("getinfo " + keys.join(" "), function (message) {
    onMap(utils.pairsToMap(info.kvStringsFromMessage(message)
                               .map(info.stringToKV)
                               .map(info.parseValueString)));
  });
};

// __info.getInfo(controlSocket, key, onValue)__.
// Requests info for a single key. Passes onValue the value for that key.
info.getInfo = function (controlSocket, key, onValue) {
  info.getInfoMultiple(controlSocket, [key], function (valueMap) {
    onValue(valueMap[key]);
  });
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
