/**
 * @name core.draft
 * @namespace The annual draft of new prospects.
 */
define(["db", "globals", "ui", "core/finances", "core/player", "core/team", "util/helpers", "util/random"], function (db, g, ui, finances, player, team, helpers, random) {
    "use strict";

    /**
     * Retrieve the current remaining draft order.
     *
     * @memberOf core.draft
     * @param {function(Array.<Object>)} cb Callback function whose argument is an ordered array of pick objects.
     */
    function getOrder(cb) {
        g.dbl.transaction("draftOrder").objectStore("draftOrder").get(0).onsuccess = function (event) {
            var draftOrder;

            draftOrder = event.target.result.draftOrder;
            cb(draftOrder);
        };
    }

    /**
     * Save draft order for future picks to the database.
     *
     * @memberOf core.draft
     * @param {Array.<Object>} draftOrder Ordered array of pick objects, as generated by genOrder.
     * @param {function()=} cb Optional callback function.
     */
    function setOrder(draftOrder, cb) {
        var tx;

        tx = g.dbl.transaction("draftOrder", "readwrite");
        tx.objectStore("draftOrder").put({
            rid: 0,
            draftOrder: draftOrder
        });
        tx.oncomplete = function () {
            if (cb !== undefined) {
                cb();
            }
        };
    }

    /**
     * Generate a set of draft prospects.
     *
     * This is called after draft classes are moved up a year, to create the new UNDRAFTED_3 class. It's also called 3 times when a new league starts, to create all 3 draft classes.
     *
     * @memberOf core.draft
     * @param {IDBTransaction|null} ot An IndexedDB transaction on players, readwrite; if null is passed, then a new transaction will be used.
     * @param {number} tid Team ID number for the generated draft class. Should be g.PLAYER.UNDRAFTED, g.PLAYER.UNDRAFTED_2, or g.PLAYER.UNDRAFTED_3.
     * @param {number?} scoutingRank Between 1 and g.numTeams, the rank of scouting spending, probably over the past 3 years via core.finances.getRankLastThree. If null, then it's automatically found.
     * @param {number?} numPlayers The number of prospects to generate. Default value is 70.
     * @param {function()} cb Callback function.
     */
    function genPlayers(ot, tid, scoutingRank, numPlayers, cb) {
        var withScoutingRank;

        if (numPlayers === null || numPlayers === undefined) {
            numPlayers = Math.round(70 * g.numTeams / 30); // 70 scaled by number of teams
        }

        withScoutingRank = function (scoutingRank) {
            var agingYears, baseAge, baseRating, draftYear, i, p, playerStore, pot, profile, profiles, tx;

            tx = db.getObjectStore(ot, "players", null, true);
            playerStore = tx.objectStore("players");

            profiles = ["Point", "Wing", "Big", "Big", ""];
            for (i = 0; i < numPlayers; i++) {
                baseRating = random.randInt(8, 31);
                pot = Math.round(helpers.bound(random.realGauss(48, 17), baseRating, 90));

                profile = profiles[random.randInt(0, profiles.length - 1)];
                agingYears = random.randInt(0, 3);
                draftYear = g.season;

                baseAge = 19;
                if (g.season === g.startingSeason && g.phase < g.PHASE.DRAFT) {
                    // New league, creating players for draft in same season and following 2 seasons
                    if (tid === g.PLAYER.UNDRAFTED_2) {
                        baseAge -= 1;
                        draftYear += 1;
                    } else if (tid === g.PLAYER.UNDRAFTED_3) {
                        baseAge -= 2;
                        draftYear += 2;
                    }
                } else if (tid === g.PLAYER.UNDRAFTED_3) {
                    // Player being generated after draft ends, for draft in 3 years
                    baseAge -= 3;
                    draftYear += 3;
                }

                p = player.generate(tid, baseAge, profile, baseRating, pot, draftYear, false, scoutingRank);
                p = player.develop(p, agingYears, true);

                playerStore.put(p);
            }

            if (ot !== null) {
                // This function doesn't have its own transaction, so we need to call the callback now even though the update might not have been processed yet.
                if (cb !== undefined) {
                    cb();
                }
            } else {
                // This function has its own transaction, so wait until it finishes before calling the callback.
                tx.oncomplete = function () {
                    if (cb !== undefined) {
                        cb();
                    }
                };
            }
        };

        if (!scoutingRank) {
            db.getObjectStore(ot, "teams", "teams").get(g.userTid).onsuccess = function (event) {
                var t;

                t = event.target.result;
                scoutingRank = finances.getRankLastThree(t, "expenses", "scouting");
                withScoutingRank(scoutingRank);
            };
        } else {
            withScoutingRank(scoutingRank);
        }
    }

    /**
     * Sets draft order and save it to the draftOrder object store.
     *
     * This is currently based on an NBA-like lottery, where the first 3 picks can be any of the non-playoff teams (with weighted probabilities).
     *
     * @memberOf core.draft
     * @param {function()=} cb Optional callback function.
     */
    function genOrder(cb) {
        team.filter({
            attrs: ["tid", "cid"],
            seasonAttrs: ["winp", "playoffRoundsWon"],
            season: g.season
        }, function (teams) {
            var chances, draw, firstThree, i, pick;

            // Sort teams by playoffs and winp, for first round
            teams.sort(function (a, b) {
                if (a.playoffRoundsWon < b.playoffRoundsWon) {
                    return -1;
                }
                if (a.playoffRoundsWon > b.playoffRoundsWon) {
                    return 1;
                }
                return a.winp - b.winp;
            });

            // Draft lottery
            chances = [250, 199, 156, 119, 88, 63, 43, 28, 17, 11, 8, 7, 6, 5];
            // cumsum
            for (i = 1; i < chances.length; i++) {
                chances[i] = chances[i] + chances[i - 1];
            }
            // Pick first three picks based on chances
            firstThree = [];
            while (firstThree.length < 3) {
                draw = random.randInt(1, 1000);
                for (i = 0; i < chances.length; i++) {
                    if (chances[i] > draw) {
                        break;
                    }
                }
                if (firstThree.indexOf(i) < 0) {
                    firstThree.push(i);
                }
            }

            g.dbl.transaction("draftPicks").objectStore("draftPicks").index("season").getAll(g.season).onsuccess = function (event) {
                var draftPickStore, draftPicks, draftOrder, draftPicksIndexed, i, tid;

                draftPicks = event.target.result;
                // Reorganize this to an array indexed on originalTid and round
                draftPicksIndexed = [];
                for (i = 0; i < draftPicks.length; i++) {
                    tid = draftPicks[i].originalTid;
                    // Initialize to an array
                    if (draftPicksIndexed.length < tid || draftPicksIndexed[tid] === undefined) {
                        draftPicksIndexed[tid] = [];
                    }
                    draftPicksIndexed[tid][draftPicks[i].round] = {
                        tid: draftPicks[i].tid
                    };
                }

                draftOrder = [];
                // First round - lottery winners
                for (i = 0; i < firstThree.length; i++) {
                    tid = draftPicksIndexed[teams[firstThree[i]].tid][1].tid;
                    draftOrder.push({
                        round: 1,
                        pick: i + 1,
                        tid: tid,
                        originalTid: teams[firstThree[i]].tid
                    });
                }

                // First round - everyone else
                pick = 4;
                for (i = 0; i < teams.length; i++) {
                    if (firstThree.indexOf(i) < 0) {
                        tid = draftPicksIndexed[teams[i].tid][1].tid;
                        draftOrder.push({
                            round: 1,
                            pick: pick,
                            tid: tid,
                            originalTid: teams[i].tid
                        });
                        pick += 1;
                    }
                }

                // Sort teams by winp only, for second round
                teams.sort(function (a, b) { return a.winp - b.winp; });

                // Second round
                for (i = 0; i < teams.length; i++) {
                    tid = draftPicksIndexed[teams[i].tid][2].tid;
                    draftOrder.push({
                        round: 2,
                        pick: i + 1,
                        tid: tid,
                        originalTid: teams[i].tid
                    });
                }

                // Delete from draftPicks object store so that they are completely untradeable
                draftPickStore = g.dbl.transaction("draftPicks", "readwrite").objectStore("draftPicks");
                for (i = 0; i < draftPicks.length; i++) {
                    draftPickStore.delete(draftPicks[i].dpid);
                }

                setOrder(draftOrder, cb);
            };
        });
    }

    /**
     * Sets fantasy draft order and save it to the draftOrder object store.
     *
     * Randomize team order and then snake for 12 rounds.
     *
     * @memberOf core.draft
     * @param {function()=} cb Optional callback function.
     */
    function genOrderFantasy(position, cb) {
        var draftOrder, i, round, tids;

        // Randomly-ordered list of tids
        tids = [];
        for (i = 0; i < g.numTeams; i++) {
            tids.push(i);
        }
        random.shuffle(tids);
        if (position >= 1 && position <= g.numTeams) {
            i = 0;
            while (tids[position - 1] !== g.userTid && i < 1000) {
                random.shuffle(tids);
                i += 1;
            }
        }

        // Set total draft order: 12 rounds, snake
        draftOrder = [];
        for (round = 1; round <= 12; round++) {
            for (i = 0; i < tids.length; i++) {
                draftOrder.push({
                    round: round,
                    pick: i + 1,
                    tid: tids[i],
                    originalTid: tids[i]
                });
            }

            tids.reverse(); // Snake
        }

        setOrder(draftOrder, cb);
    }

    /**
     * Get a list of rookie salaries for all players in the draft.
     *
     * By default there are 60 picks, but some are added/removed if there aren't 30 teams.
     *
     * @memberOf core.draft
     * @param {Array.<number>} cb Array of salaries, in thousands of dollars/year.
     */
    function getRookieSalaries() {
        var rookieSalaries;

        // Default for 60 picks
        rookieSalaries = [5000, 4500, 4000, 3500, 3000, 2750, 2500, 2250, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500];

        while (g.numTeams * 2 > rookieSalaries.length) {
            // Add min contracts on to end
            rookieSalaries.push(500);
        }
        while (g.numTeams * 2 < rookieSalaries.length) {
            // Remove smallest salaries
            rookieSalaries.pop();
        }

        return rookieSalaries;
    }

    /**
     * Select a player for the current drafting team.
     *
     * This can be called in response to the user clicking the "draft" button for a player, or by some other function like untilUserOrEnd.
     *
     * @memberOf core.draft
     * @param {object} pick Pick object, like from getOrder, that contains information like the team, round, etc.
     * @param {number} pid Integer player ID for the player to be drafted.
     * @param {function(<number>)=} cb Optional callback function. Argument is the player ID that was drafted (same as pid input.. probably this can be eliminated, then).
     */
    function selectPlayer(pick, pid, cb) {
        var tx;
/*        // Validate that tid should be picking now
        r = g.dbex('SELECT tid, round, pick FROM draftResults WHERE season = :season AND pid = 0 ORDER BY round, pick ASC LIMIT 1', season=g.season);
        tidNext, round, pick = r.fetchone();

        if (tidNext != pick.tid) {
            app.logger.debug('WARNING: Team %d tried to draft out of order' % (tid,));
            return;*/

        tx = g.dbl.transaction("players", "readwrite");
        tx.objectStore("players").openCursor(pid).onsuccess = function (event) {
            var cursor, i, p, rookieSalaries, years;

            cursor = event.target.result;
            p = cursor.value;

            // Draft player
            p.tid = pick.tid;
            if (g.phase !== g.PHASE.FANTASY_DRAFT) {
                p.draft = {
                    round: pick.round,
                    pick: pick.pick,
                    tid: pick.tid,
                    year: g.season,
                    originalTid: pick.originalTid,
                    pot: p.ratings[0].pot,
                    ovr: p.ratings[0].ovr,
                    skills: p.ratings[0].skills
                };
            }

            // Contract
            if (g.phase !== g.PHASE.FANTASY_DRAFT) {
                rookieSalaries = getRookieSalaries();
                i = pick.pick - 1 + g.numTeams * (pick.round - 1);
                years = 4 - pick.round;  // 2 years for 2nd round, 3 years for 1st round;
                p = player.setContract(p, {
                    amount: rookieSalaries[i],
                    exp: g.season + years
                }, true);
            }

            // Add stats row if necessary (fantasy draft in ongoing season)
            if (g.phase === g.PHASE.FANTASY_DRAFT && g.phase <= g.PHASE.PLAYOFFS) {
                p = player.addStatsRow(p);
            }

            cursor.update(p);
        };

        tx.oncomplete = function () {
            if (cb !== undefined) {
                cb(pid);
            }
        };
    }

    /**
     * Simulate draft picks until it's the user's turn or the draft is over.
     *
     * This could be made faster by passing a transaction around, so all the writes for all the picks are done in one transaction. But when calling selectPlayer elsewhere (i.e. in testing or in response to the user's pick), it needs to be sure that the transaction is complete before continuing. So I would need to create a special case there to account for it. Given that this isn't really *that* slow now, that probably isn't worth the complexity. Although... team.rosterAutoSort does precisely this... so maybe it would be a good idea...
     *
     * @memberOf core.draft
     * @param {function(Array.<Object>, Array.<number>)} cb Callback function. First argument is the list of draft picks (from getOrder). Second argument is a list of player IDs who were drafted during this function call, in order.
     */
    function untilUserOrEnd(cb) {
        var pids, season;

        pids = [];

        season = require("core/season");

        g.dbl.transaction("players").objectStore("players").index("tid").getAll(g.PLAYER.UNDRAFTED).onsuccess = function (event) {
            var playersAll;

            playersAll = event.target.result;
            playersAll.sort(function (a, b) { return player.value(b) - player.value(a); });

            getOrder(function (draftOrder) {
                var autoSelectPlayer, cbAfterDoneAuto, pick, pid, selection;

                // Called after either the draft is over or it's the user's pick
                cbAfterDoneAuto = function (draftOrder, pids) {
                    setOrder(draftOrder, function () {
                        var season, tx;

                        // Is draft over?;
                        if (draftOrder.length === 0) {
                            season = require("core/season"); // Circular reference
                            if (g.phase === g.PHASE.FANTASY_DRAFT) {
                                // Undrafted players become free agents
                                tx = g.dbl.transaction(["players", "teams"], "readwrite");
                                player.genBaseMoods(tx, function (baseMoods) {
                                    var playerStore;

                                    playerStore = tx.objectStore("players");
                                    playerStore.index("tid").openCursor(g.PLAYER.UNDRAFTED).onsuccess = function (event) {
                                        var cursor, p;

                                        cursor = event.target.result;
                                        if (cursor) {
                                            p = cursor.value;
                                            player.addToFreeAgents(playerStore, p, g.PHASE.FREE_AGENCY, baseMoods);
                                            cursor.continue();
                                        } else {
                                            // Swap back in normal draft class
                                            playerStore.index("tid").openCursor(g.PLAYER.UNDRAFTED_FANTASY_TEMP).onsuccess = function (event) {
                                                var cursor, p;

                                                cursor = event.target.result;
                                                if (cursor) {
                                                    p = cursor.value;

                                                    p.tid = g.PLAYER.UNDRAFTED;

                                                    cursor.update(p);
                                                    cursor.continue();
                                                } else {
                                                    db.setGameAttributes({
                                                        lastDbChange: Date.now(),
                                                        phase: g.nextPhase,
                                                        nextPhase: null
                                                    }, function () {
                                                        ui.updatePhase(g.season + season.phaseText[g.phase]);
                                                        ui.updatePlayMenu(null, function () {
                                                            cb(pids);
                                                        });
                                                    });
                                                }
                                            };
                                        }
                                    };
                                });
                            } else {
                                // Normal
                                season.newPhase(g.PHASE.AFTER_DRAFT, function () {
                                    cb(pids);
                                });
                            }
                        } else {
                            db.setGameAttributes({lastDbChange: Date.now()}, function () {
                                cb(pids);
                            });
                        }
                    });
                };

                // This will actually draft "untilUserOrEnd"
                autoSelectPlayer = function () {
                    if (draftOrder.length > 0) {
                        pick = draftOrder.shift();
                        if (pick.tid === g.userTid) {
                            draftOrder.unshift(pick);
                            cbAfterDoneAuto(draftOrder, pids);
                            return;
                        }

                        selection = Math.floor(Math.abs(random.gauss(0, 2)));  // 0=best prospect, 1=next best prospect, etc.
                        pid = playersAll[selection].pid;
                        selectPlayer(pick, pid, function () {
                            pids.push(pid);
                            playersAll.splice(selection, 1);  // Delete from the list of undrafted players

                            autoSelectPlayer();
                        });
                    } else {
                        cbAfterDoneAuto(draftOrder, pids);
                    }
                };

                autoSelectPlayer();
            });
        };
    }

    return {
        getOrder: getOrder,
        setOrder: setOrder,
        genPlayers: genPlayers,
        genOrder: genOrder,
        genOrderFantasy: genOrderFantasy,
        untilUserOrEnd: untilUserOrEnd,
        getRookieSalaries: getRookieSalaries,
        selectPlayer: selectPlayer
    };
});
