const g = require('../globals');
const ui = require('../ui');
const league = require('../core/league');
const Promise = require('bluebird');
const $ = require('jquery');
const ko = require('knockout');
const komapping = require('knockout.mapping');
const bbgmView = require('../util/bbgmView');
const helpers = require('../util/helpers');
const viewHelpers = require('../util/viewHelpers');

function InitViewModel() {
    this.invalidLeagueFile = ko.observable(false);
    this.uploadSelected = ko.observable(false);
    this.disableSubmit = ko.computed(function () {
        return this.invalidLeagueFile() && this.uploadSelected();
    }, this);
}

// Keep only relevant information, otherwise Knockout has to do extra work creating all kinds of observables
function removeUnneededTeamProps(teams) {
    var i, prop, propsToKeep;

    // These are used in newLeague.html and updatePopText
    propsToKeep = ["name", "pop", "popRank", "region", "tid"];

    for (i = 0; i < teams.length; i++) {
        // Remove unneeded properties
        for (prop in teams[i]) {
            if (teams[i].hasOwnProperty(prop)) {
                if (propsToKeep.indexOf(prop) === -1) {
                    delete teams[i][prop];
                }
            }
        }
    }

    return teams;
}

function post(req) {
    Promise.try(function () {
        var file, startingSeason, tid;

        document.getElementById("create-new-league").disabled = true;

        startingSeason = 2015;

        tid = parseInt(req.params.tid, 10);
        localStorage.lastSelectedTid = tid;

        // Davis.js can't handle file uploads, so do this manually first
        if (req.params.rosters === "custom-rosters") {
            file = document.getElementById("custom-rosters-file").files[0];
            if (file !== undefined) {
                return new Promise(function (resolve) {
                    var reader;

                    reader = new window.FileReader();
                    reader.readAsText(file);
                    reader.onload = function (event) {
                        var leagueFile, randomizeRosters;

                        leagueFile = JSON.parse(event.target.result);
                        startingSeason = leagueFile.startingSeason !== undefined ? leagueFile.startingSeason : startingSeason;

                        randomizeRosters = req.params.hasOwnProperty("randomize-rosters");

                        league.create(req.params.name, tid, leagueFile, startingSeason, randomizeRosters).then(resolve);
                    };
                });
            }
        }

        return league.create(req.params.name, tid, undefined, startingSeason, false);
    }).then(function (lid) {
        ui.realtimeUpdate([], "/l/" + lid, function () {
            // Show helpful information if this is the first league
            if (lid === 1) {
                ui.highlightPlayButton();
            }
        });
    });
}

function updateNewLeague() {
    var newLid;

    newLid = null;

    // Find most recent league and add one to the LID
    return g.dbm.leagues.iterate("prev", function (l, shortCircuit) {
        newLid = l.lid + 1;
        shortCircuit();
    }).then(function () {
        var teams;

        if (newLid === null) {
            newLid = 1;
        }

        teams = removeUnneededTeamProps(helpers.getTeamsDefault());
        teams.unshift({
            tid: -1,
            region: "Random",
            name: "Team"
        });

        return {
            name: "League " + newLid,
            teams: teams,
            lastSelectedTid: parseInt(localStorage.lastSelectedTid, 10)
        };
    });
}

function uiFirst(vm) {
    var fileEl, newLeagueRostersEl, selectRosters, selectTeam, setTeams, updatePopText, updateShowUploadForm, useCustomTeams;

    ui.title("Create New League");

    updatePopText = function () {
        var difficulty, team;

        team = vm.teams()[parseInt(selectTeam.val(), 10) + 1];

        if (team.tid() >= 0) {
            if (team.popRank() <= 3) {
                difficulty = "very easy";
            } else if (team.popRank() <= 8) {
                difficulty = "easy";
            } else if (team.popRank() <= 16) {
                difficulty = "normal";
            } else if (team.popRank() <= 24) {
                difficulty = "hard";
            } else {
                difficulty = "very hard";
            }

            document.getElementById("pop-text").innerHTML = "Region population: " + team.pop() + " million, #" + team.popRank() + " leaguewide<br>Difficulty: " + difficulty;
        } else {
            document.getElementById("pop-text").innerHTML = "Region population: ?<br>Difficulty: ?";
        }
    };

    selectTeam = $("select[name='tid']");
    selectTeam.change(updatePopText);
    selectTeam.keyup(updatePopText);

    updateShowUploadForm = function () {
        if (selectRosters.val() === "custom-rosters") {
            $("#custom-rosters").show();
            $("#randomize-rosters").show();
            vm.uploadSelected(true);
        } else {
            $("#custom-rosters").hide();
            $("#randomize-rosters").hide();
            vm.uploadSelected(false);
        }
    };

    selectRosters = $("select[name='rosters']");
    selectRosters.change(updateShowUploadForm);
    selectRosters.keyup(updateShowUploadForm);

    updatePopText();
    updateShowUploadForm();

    // Handle custom roster teams
    setTeams = function (newTeams) {
        var i;

        if (newTeams !== undefined) {
            for (i = 0; i < newTeams.length; i++) {
                // Is pop hidden in season, like in editTeamInfo import?
                if (!newTeams[i].hasOwnProperty("pop") && newTeams[i].hasOwnProperty("seasons")) {
                    newTeams[i].pop = newTeams[i].seasons[newTeams[i].seasons.length - 1].pop;
                }

                newTeams[i].pop = helpers.round(newTeams[i].pop, 2);
            }

            newTeams = helpers.addPopRank(newTeams);

            newTeams = removeUnneededTeamProps(newTeams);

            // Add random team
            newTeams.unshift({
                tid: -1,
                region: "Random",
                name: "Team"
            });

            komapping.fromJS({teams: newTeams}, vm);
        }

        updatePopText();
    };
    useCustomTeams = function () {
        var file, reader;

        if (fileEl.files.length) {
            vm.invalidLeagueFile(false);

            file = fileEl.files[0];

            reader = new window.FileReader();
            reader.readAsText(file);
            reader.onload = function (event) {
                var leagueFile, newTeams;

                try {
                    leagueFile = JSON.parse(event.target.result);
                } catch (e) {
                    vm.invalidLeagueFile(true);
                    return;
                }

                newTeams = leagueFile.teams;
                setTeams(newTeams);

                // Is a userTid specified?
                if (leagueFile.hasOwnProperty("gameAttributes")) {
                    leagueFile.gameAttributes.some(function (attribute) {
                        if (attribute.key === "userTid") {
                            // Set it to select the userTid entry
                            document.getElementById("new-league-tid").value = attribute.value;
                            updatePopText(); // Not caught by event handlers for some reason
                            return true;
                        }
                    });
                }
            };
        }
    };
    fileEl = document.getElementById("custom-rosters-file");
    fileEl.addEventListener("change", useCustomTeams);
    // Handle switch away from custom roster teams
    newLeagueRostersEl = document.getElementById("new-league-rosters");
    newLeagueRostersEl.addEventListener("change", function () {
        if (this.value === "custom-rosters") {
            useCustomTeams();
        } else {
            setTeams(helpers.getTeamsDefault());
        }
    });
}

module.exports = bbgmView.init({
    id: "newLeague",
    beforeReq: viewHelpers.beforeNonLeague,
    InitViewModel,
    post,
    runBefore: [updateNewLeague],
    uiFirst
});
