/* jshint moz: true */
/* jshint -W097 */
/* global document, gBrowser, Components */
"use strict";

// __circuits, domains__.
// Storage for all observed circuits and domains.
let circuitData = {}, circuitIdToDomainMap = {}, domainToNodeDataMap = {};

let bundleService = Components.classes["@mozilla.org/intl/stringbundle;1"]
                                    .getService(Components.interfaces.nsIStringBundleService),
    regionBundle = bundleService.createBundle(
                     "chrome://global/locale/regionNames.properties");

// nodeDataForID(controller, id, onResult)__.
// Requests the IP, country code, and name of a node with given ID.
// Returns result via onResult.
// Example: nodeData(["20BC91DC525C3DC9974B29FBEAB51230DE024C44"], show);
let nodeDataForID = function (controller, ids, onResult) {
  let idRequests = ids.map(function (id) { return "ns/id/" + id; });
  controller.getInfoMultiple(idRequests, function (statusMaps) {
    let IPs = statusMaps.map(function (statusMap) { return statusMap.IP; }),
        countryRequests = IPs.map(function (ip) { return "ip-to-country/" + ip; });
    controller.getInfoMultiple(countryRequests, function (countries) {
      let results = [];
      for (let i = 0; i < ids.length; ++i) {
        results.push({ name : statusMaps[i].nickname, id : ids[i] ,
                       ip : statusMaps[i].IP , country : countries[i] });
      }
      onResult(results);
    });
  });
};

// __nodeDataForCircuit(controller, circuitData, onResult)__.
// Gets the information for a circuit.
let nodeDataForCircuit = function (controller, circuitData, onResult) {
  let ids = [];
  for (var i = 0; i < 3; ++i) {
    ids.push(circuitData.circuit[i][0]);
  }
  nodeDataForID(controller, ids, onResult);
};

// __localizedCountryNameFromCode(countryCode)__.
// Convert a country code to a localized country name.
// Example: `'de'` -> `'Deutschland'` in German locale.
let localizedCountryNameFromCode = function (countryCode) {
  try {
    return regionBundle.GetStringFromName(countryCode.toLowerCase());
  } catch (e) {
    return countryCode.toUpperCase();
  }
};

// __nodeLines(nodeData)__.
// Takes a nodeData array of three items each like
// `{ ip : "12.34.56.67", country : "fr" }`
// and converts each node data to text.
// `"France (12.34.56.78)"`.
let nodeLines = function (nodeData) {
  let result = ["This browser"];
  for (let {ip, country} of nodeData) {
    result.push(localizedCountryNameFromCode(country) + " (" + ip + ")");
  }
  result.push("Internet");
  return result;
};

// __updateCircuitDisplay__.
// Updates the Tor circuit display SVG, showing the current domain
// and the relay nodes for that domain.
let updateCircuitDisplay = function () {
  let URI = gBrowser.selectedBrowser.currentURI,
      domain = null,
      nodeData = null;
  // Try to get a domain for this URI. Otherwise it remains null.
  try {
    domain = URI.host;
  } catch (e) { }
  if (domain) {
  // Check if we have anything to show for this domain.
    nodeData = domainToNodeDataMap[domain];
    if (nodeData) {   
      // Update the displayed domain.
	  document.querySelector("svg#tor-circuit text#domain").innerHTML = "(" + domain + "):";
	  // Update the display information for the relay nodes.
      let diagramNodes = document.querySelectorAll("svg#tor-circuit text.node"),
      lines = nodeLines(nodeData);       
      for (let i = 0; i < diagramNodes.length; ++i) {
        diagramNodes[i].innerHTML = lines[i];
      }
    }
  }
  // Only show the Tor circuit if we have a domain and node data.
  document.querySelector("svg#tor-circuit").style.display = (domain && nodeData) ?
                                                            'block' : 'none';
};

// __collectBuiltCircuitData(aController)__.
// Watches for CIRC BUILT events and records their data in the circuitData map.
let collectBuiltCircuitData = function (aController) {
  aController.watchEvent("CIRC", function (data) { return data.status === "BUILT"; },
                         function (data) {
                           circuitData[data.id] = data;
                         });
};

// __assignCircuitsForDomains__.
// Watches STREAM events. Whenever a new circuit gets its first STREAM SENTCONNECT event,
// assign the domain to the circuit ID and record circuit data for that domain.
let assignCircuitsForDomains = function (aController) {
  aController.watchEvent("STREAM",
                         // Only look at SENTCONNECT events.
                         function ({ StreamStatus }) { return StreamStatus === "SENTCONNECT"; },
                         // Record the first domain for any new circuit, and 
                         // assign the node data for that circuit to the domain.
                         // Display anything new.
                         function ({ Target, CircuitID }) {
                           let domain = Target.split(":")[0];
                           if (circuitIdToDomainMap[CircuitID] === undefined) {
                             circuitIdToDomainMap[CircuitID] = domain;
                             nodeDataForCircuit(aController, circuitData[CircuitID],
                               function (nodeData) {
                                 domainToNodeDataMap[domain] = nodeData;
                                 // We now have new node data; show it in display.
                                 updateCircuitDisplay();
                               });
                           }
                         });
};

// __syncDisplayWithSelectedTab()__.
// We may have multiple tabs, but there is only one instance of TorButton's popup
// panel for displaying the Tor circuit UI. Therefore we need to update the display
// to show the currently selected tab at its current location.
let syncDisplayWithSelectedTab = function () {
  // Whenever a different tab is selected, change the circuit display
  // to show the circuit for that tab's domain.
  gBrowser.tabContainer.addEventListener("TabSelect", function (event) {
    updateCircuitDisplay();
  });
  // If the currently selected tab has been sent to a new location,
  // update the circuit to reflect that.
  gBrowser.addTabsProgressListener({ onLocationChange : function (aBrowser) {
    if (aBrowser == gBrowser.selectedBrowser) {
      updateCircuitDisplay();
    }
  } });
  // Get started with a correct display.
  updateCircuitDisplay();
};

// __runTorStatusDisplay(controller)__.
let runTorStatusDisplay = function (controller) {
  syncDisplayWithSelectedTab();
  collectBuiltCircuitData(controller);
  assignCircuitsForDomains(controller);
};