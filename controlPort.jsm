// A script for TorBrowser that provides an asynchronous controller for
// Tor, through its ControlPort.
//
// This file is written in call stack order (later functions
// call earlier functions). The file can be processed
// with docco.js to produce pretty documentation.
//
// To import the module, use
//
//     let { controlSocket } = Components.utils.import("path/to/controlPort.jsm");
//
// See the last function defined in this file, controlSocket(host, port)
// for usage of the controlSocket function.

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

// ## tor
// Namespace for tor-specific functions
let tor = tor || {};

// __tor.onLineFromOnMessage(onMessage)__.
// Converts a callback that expects incoming control port multiline message strings to a
// callback that expects individual lines.
tor.onLineFromOnMessage = function (onMessage) {
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

// __tor.controlSocket(host, port, password, onError)__.
// The non-cached version of controlSocket(host, port), documented below.
tor.controlSocket = function (host, port, password, onError) {
  // Produce a callback dispatcher for Tor messages.
  let [onMessage, mainDispatcher] = io.callbackDispatcher(),
      // Open the socket and convert format to Tor messages.
      socket = io.asyncSocket(host, port,
                              io.onDataFromOnLine(tor.onLineFromOnMessage(onMessage)),
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

// __tor.controlSocketCache__.
// A map from "host:port" to controlSocket objects. Prevents redundant instantiation
// of control sockets.
tor.controlSocketCache = {};

// __tor.capture(string, regex)__.
// Takes a string and returns an array of capture items, where regex must have a single
// capturing group and use the suffix /.../g to specify a global search.
tor.capture = function (string, regex) {
  let matches = [];
  // Special trick to use string.replace for capturing multiple matches.
  string.replace(regex, function (a, captured) {
    matches.push(captured);
  });
  return matches;
};

// __tor.extractor(regex)__.
// Returns a function that takes a string and returns an array of regex matches. The
// regex must use the suffix /.../g to specify a global search.
tor.extractor = function (regex) {
  return function (text) {
    return tor.capture(text, regex);
  };
};

// __tor.infoKVStringsFromMessage(messageText)__.
// Takes a message (text) response to GETINFO and provides a series of key-value (KV)
// strings. KV strings are either multiline (with a "250+" prefix):
//
//     250+config/defaults=
//     AccountingMax "0 bytes"
//     AllowDotExit "0"
//     .
//
// or single-line (with a "250-" prefix):
//
//     250-version=0.2.6.0-alpha-dev (git-b408125288ad6943)
tor.infoKVStringsFromMessage = tor.extractor(/^(250\+[\s\S]+?^\.|250-.+?)$/gmi);

// __tor.stringToKV(kvString)__.
// Converts a key-value (KV) string to a key, value pair as from GETINFO. 
tor.stringToKV = function (kvString) {
  let key = kvString.match(/^250[\+-](.+?)=/mi)[1],
      matchResult = kvString.match(/250\-.+?=(.*?)$/mi) ||
                    kvString.match(/250\+.+?=([\s\S]*?)^\.$/mi),
      value = matchResult ? matchResult[1] : null;
  return [key, value];
};

// __tor.pairsToMap(pairs)__.
// Convert a series of pairs [[a1, b1], [a2, b2], ...] to a map {a1 : b1, a2 : b2 ...}.
tor.pairsToMap = function (pairs) {
  let result = {};
  pairs.map(function ([a, b]) {
    result[a] = b;
  });
  return result;
};

// __identity__.
// Returns its argument.
let identity = function (x) { return x; };

// __returnError__.
// Returns a function that, when applied to any argument, returns an error with the
// given message text.
let returnError = function (message) { return function (x) {
    throw new Error(x + ": " + message + ".");
  };
};

// __notSupported(x)__. Returns a "not supported" error when applied to any value.
let notSupported = returnError("not supported");

// __deprecated(x)__. Returns a "deprecated" error when applied to any value.
let deprecated = returnError("deprecated");

// __unknown(x)__. Returns an "unknown" error when applied to any value.
let unknown = returnError("unknown");

// __asInt(x)__. Returns a decimal number in a string into a number.
let asInt = function (x) { return parseInt(x, 10); };

// __tor.valueStringParsers__.
// Provides a function that converts the string response to a GETINFO request
// into JavaScript data.
tor.valueStringParsers = {
  "version" : identity,
  "config-file" : identity,
  "config-defaults-file" : identity,
  "config-text" : identity,
  "exit-policy/" : notSupported,
  "desc/id/" : notSupported,
  "desc/name/" : notSupported,
  "md/id/" : notSupported,
  "md/name/" : notSupported,
  "dormant" : notSupported,
  "desc-annotations/id/" : notSupported,
  "extra-info/digest/" : notSupported,
  "ns/id/" : notSupported,
  "ns/name/" : notSupported,
  "ns/all/" : notSupported,
  "ns/purpose/" : notSupported,
  "desc/all-recent" : notSupported,
  "network-status" : notSupported,
  "address-mappings/" : notSupported,
  "addr-mappings/" : deprecated,
  "address" : identity,
  "fingerprint" : identity,
  "circuit-status" : notSupported,
  "stream-status" : notSupported,
  "orconn-status" : notSupported,
  "entry-guards" : notSupported,
  "traffic/read" : asInt,
  "traffic/written" : asInt,
  "accounting/enabled" : function (x) { return x === "1"; },
  "accounting/hibernating" : identity,
  "accounting/bytes" : notSupported,
  "accounting/bytes-left" : notSupported,
  "accounting/interval-start" : notSupported,
  "accounting/interval-wake" : notSupported,
  "accounting/interval-end" : notSupported,
  "config/names" : notSupported,
  "config/defaults" : notSupported,
  "info/names" : notSupported,
  "events/names" : notSupported,
  "features/names" : notSupported,
  "signal/names" : notSupported,
  "ip-to-country/" : identity,
  "next-circuit/" : identity,
  "process/" : identity,
  "process/descriptor-limit" : asInt,
  "dir/status-vote/current/consensus" : notSupported,
  "dir/status/" : notSupported,
  "dir/server/" : notSupported,
  "status/" : notSupported,
  "net/listeners/" : notSupported,
  "dir-usage" : notSupported
};

// __tor.getValueStringParser(key)__.
// Takes a key a determines the parser function that should be used to
// convert its corresponding valueString to JavaScript data.
tor.getValueStringParser = function(key) {
  return tor.valueStringParsers[key] ||
         tor.valueStringParsers[key.substring(0, key.lastIndexOf("/") + 1)] ||
         unknown;         
};

// __tor.parseValueString([key, valueString])__
// Takes a [key, valueString] pair and converts it to useful data, appropriate to the key.
tor.parseValueString = function ([key, valueString]) {
  return [key, tor.getValueStringParser(key)(valueString)];
};

// __tor.getInfoMultiple__.
// Requests info for an array of keys. Passes onMap a map of keys to values.
tor.getInfoMultiple = function (controlSocket, keys, onMap) {
  parsers = keys.map(tor.getValueStringParser);
  if (parsers.indexOf(notSupported) != -1) {
    throw new Error("Unsupported key.");
  }
  if (parsers.indexOf(deprecated) != -1) {
    throw new Error("Deprecated key.");
  }
  if (parsers.indexOf(unknown) != -1) {
    throw new Error("Unknown key.");
  }
  controlSocket.sendCommand("getinfo " + keys.join(" "), function (message) {
    onMap(tor.pairsToMap(tor.infoKVStringsFromMessage(message)
                            .map(tor.stringToKV)
                            .map(tor.parseValueString)));
  });
};

// __tor.getInfo__.
// Requests info for a single key. Passes onValue the value for that key.
tor.getInfo = function (controlSocket, key, onValue) {
  tor.getInfoMultiple(controlSocket, [key], function (valueMap) {
    onValue(valueMap[key]);
  });
};

// __tor.controller__.
// Creates a tor controller at the given host and port, with the given password.
// onError returns asynchronously whenever a connection error occurs.
tor.controller = function (host, port, password, onError) {
  let socket = tor.controlSocket(host, port, password, onError);
  return { getInfo : function (key, log) { tor.getInfo(socket, key, log); } ,
           close : socket.close };
};

// ## Export

// __controlSocket(host, port, password, onError)__.
// Instantiates and returns a socket to a tor ControlPort at host:port,
// authenticating with the given password, if the socket doesn't yet
// exist. Otherwise returns the existing socket to the given host:port.
// onError is called with an error object as its single argument whenever
// an error occurs. Example:
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
let controlSocket = function (host, port, password, onError) {
  let dest = host + ":" + port;
  return (tor.controlSocketCache[dest] = tor.controlSocketCache[dest] ||
          tor.controlSocket(host, port, password, onError));
};

// Export the controlSocket function for external use.
var EXPORTED_SYMBOLS = ["controlSocket"];
