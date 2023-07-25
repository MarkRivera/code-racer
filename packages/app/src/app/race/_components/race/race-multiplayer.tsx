"use client";

import React, { useState, useEffect, useRef } from "react";
import type { User } from "next-auth";
import { Button } from "@/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import type { RaceParticipant, Snippet } from "@prisma/client";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Heading } from "@/components/ui/heading";
import RaceTracker from "./race-tracker";
import Code from "./code";
import RaceDetails from "./race-details";
import RaceTimer from "./race-timer";
import { ReportButton } from "./report-button";
import { endRaceAction, saveUserResultAction } from "../../actions";
import { calculateAccuracy, calculateCPM } from "./utils";
import { io, type Socket } from "socket.io-client";
import {
  GameStateUpdatePayload,
  ParticipantRacePayload,
  RaceParticipantPositionPayload,
  gameStateUpdatePayloadSchema,
  raceParticipantNotificationSchema,
} from "@code-racer/wss/src/schemas";
import {
  SocketEvents,
  RaceStatus,
  type SocketPayload,
  type SocketEvent,
  type RaceStatusType,
} from "@code-racer/wss/src/events";
import MultiplayerLoadingLobby from "../multiplayer-loading-lobby";

type Participant = Omit<
  GameStateUpdatePayload["raceState"]["participants"][number],
  "socketId"
>;

let socket: Socket | null = null;

async function getSocketConnection() {
  console.log({ socket })
  if (socket) return;
  //eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //@ts-ignore
  socket = io("http://localhost:3001");
  socket.on("connect", () => {
    console.log("connected");
  })

  socket.on("disconnect", () => {
    console.log("disconnected");
  })
}

interface RaceTimeStampProps {
  char: string;
  accuracy: number;
  cpm: number;
  time: number;
}

interface ReplayTimeStampProps {
  char: string;
  textIndicatorPosition: number | number[];
  currentLineNumber: number;
  currentCharPosition: number;
  errors: number[];
  totalErrors: number;
  time: number;
}

export default function Race({
  user,
  snippet,
  participantId,
  raceId,
}: {
  participantId?: RaceParticipant["id"];
  raceId?: string;
  user?: User;
  snippet: Snippet;
}) {
  const [input, setInput] = useState("");
  const [textIndicatorPosition, setTextIndicatorPosition] = useState(0);
  const [currentLineNumber, setCurrentLineNumber] = useState(0);
  const [currentCharPosition, setCurrentCharPosition] = useState(0);
  const [currentChar, setCurrentChar] = useState("");

  const [startTime, setStartTime] = useState<Date | null>(null);
  const [submittingResults, setSubmittingResults] = useState(false);
  const [totalErrors, setTotalErrors] = useState(0);

  const [raceTimeStamp, setRaceTimeStamp] = useState<RaceTimeStampProps[]>([]);
  const [replayTimeStamp, setReplayTimeStamp] = useState<
    ReplayTimeStampProps[]
  >([]);

  const code = snippet.code.trimEnd();
  const currentText = code.substring(0, input.length);
  const errors = input
    .split("")
    .map((char, index) => (char !== currentText[index] ? index : -1))
    .filter((index) => index !== -1);

  const inputElement = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  //multiplayer-specific -----------------------------------------------------------------------------------
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [raceStatus, setRaceStatus] = useState<RaceStatusType>(
    Boolean(raceId) ? RaceStatus.WAITING : RaceStatus.RUNNING,
  );
  const [raceStartCountdown, setRaceStartCountdown] = useState(0);
  const position = parseFloat(
    (((input.length - errors.length) / code.length) * 100).toFixed(2),
  );
  const isRaceFinished = raceId
    ? raceStatus === RaceStatus.FINISHED
    : input === code;
  const showRaceTimer = !!startTime && !isRaceFinished;

  // Get snippet lanugage from params
  const searchParams = useSearchParams();
  const lang = searchParams ? searchParams.get("lang") : "";

  function startRaceEventHandlers() {
    if (!raceId || !socket) return;
    socket.on(`RACE_${raceId}`, async (payload: SocketPayload) => {
      switch (payload.type) {
        case SocketEvents.GAME_STATE_UPDATE:
          const { raceState } = gameStateUpdatePayloadSchema.parse(
            payload.payload,
          );
          setParticipants(raceState.participants);
          setRaceStatus(raceState.status);

          if (raceState.countdown) {
            setRaceStartCountdown(raceState.countdown);
          } else if (raceState.countdown === 0) {
            setStartTime(new Date());
          }
          break;

        case SocketEvents.USER_RACE_LEAVE:
          const { participantId } = raceParticipantNotificationSchema.parse(
            payload.payload,
          );
          setParticipants((participants) =>
            participants.filter(
              (participant) => participant.id !== participantId,
            ),
          );
          break;

        case SocketEvents.USER_RACE_ENTER:
          const { participantId: _participantId } =
            raceParticipantNotificationSchema.parse(payload.payload);
          setParticipants((participants) => [
            ...participants,
            { id: _participantId, position: 0, finishedAt: null },
          ]);
          break;
      }
    });
  }

  // Connection to wss
  useEffect(() => {
    if (!raceId || !participantId) return;

    getSocketConnection()
      .then(() => {
        socket!.on("connect", () => {
          socket!.emit<SocketEvent>(SocketEvents.USER_RACE_ENTER, {
            raceId,
            participantId,
            socketId: socket!.id,
          } satisfies ParticipantRacePayload);

          startRaceEventHandlers();
        })
      })
      .catch((err) => {
        console.error(err);
      });
    return () => {
      if (socket) socket.disconnect();
      socket = null;
    };
  }, []);

  //send updated position to server
  useEffect(() => {
    if (!participantId || !raceId || raceStatus !== "running") return;

    const gameLoop = setInterval(() => {
      if (raceStatus === "running") {
        socket!.emit<SocketEvent>(SocketEvents.PARTICIPANT_POSITION_UPDATE, {
          socketId: socket!.id,
          participantId,
          position,
          raceId,
        } satisfies RaceParticipantPositionPayload);
      }
    }, 200);
    return () => clearInterval(gameLoop);
  }, [raceStatus, position]);
  //end of multiplayer-specific -----------------------------------------------------------------------------------

  async function endRace() {
    //TODO: find a way to only trigger this once, not by every player in the race.
    if (raceId) {
      await endRaceAction({
        raceId,
      });
    }
    if (!startTime) return;
    const endTime = new Date();
    const timeTaken = (endTime.getTime() - startTime.getTime()) / 1000;

    localStorage.setItem(
      "raceTimeStamp",
      JSON.stringify([
        ...raceTimeStamp,
        {
          char: currentChar,
          accuracy: calculateAccuracy(input.length, totalErrors),
          cpm: calculateCPM(input.length, timeTaken),
          time: Date.now(),
        },
      ]),
    );

    localStorage.setItem(
      "replayTimeStamp",
      JSON.stringify([
        ...replayTimeStamp,
        {
          char: currentChar,
          textIndicatorPosition,
          currentLineNumber,
          currentCharPosition,
          errors,
          totalErrors,
          time: Date.now(),
        },
      ]),
    );

    if (user) {
      // console.log("saving user result");

      const result = await saveUserResultAction({
        timeTaken,
        errors: totalErrors,
        cpm: calculateCPM(code.length - 1, timeTaken),
        accuracy: calculateAccuracy(code.length - 1, totalErrors),
        snippetId: snippet.id,
      });

      if (!result) {
        return router.refresh();
      }

      router.push(`/result?resultId=${result.id}`);
    } else {
      router.push(`/result?snippetId=${snippet.id}`);
    }

    setSubmittingResults(false);
  }

  useEffect(() => {
    if (isRaceFinished) {
      // console.log("Race Finished");
      endRace();
    }
  }, [isRaceFinished]);

  useEffect(() => {
    // Focus Input
    inputElement.current?.focus();

    // Calculate the current line and cursor position in that line
    const lines = input.split("\n");
    setCurrentLineNumber(lines.length);
    setCurrentCharPosition(lines[lines.length - 1].length);
    setReplayTimeStamp((prev) => [
      ...prev,
      {
        char: currentChar,
        textIndicatorPosition,
        currentLineNumber,
        currentCharPosition,
        errors,
        totalErrors,
        time: Date.now(),
      },
    ]);
  }, [input]);

  function handleKeyboardDownEvent(e: React.KeyboardEvent<HTMLInputElement>) {
    // Restart
    if (e.key === "Escape") {
      handleRestart();
      return;
    }
    // Unfocus Shift + Tab
    if (e.shiftKey && e.key === "Tab") {
      e.currentTarget.blur();
      return;
    }
    // Reload Control + r
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault;
      return;
    }
    // Catch Alt Gr - Please confirm I am unable to test this
    if (e.ctrlKey && e.altKey) {
      e.preventDefault();
    }

    const noopKeys = [
      "Alt",
      "ArrowUp",
      "ArrowDown",
      "Control",
      "Meta",
      "CapsLock",
      "Shift",
      "altGraphKey", // - Please confirm I am unable to test this
      "AltGraph", // - Please confirm I am unable to test this
      "ContextMenu",
      "Insert",
      "Delete",
      "PageUp",
      "PageDown",
      "Home",
      "OS",
      "NumLock",
      "Tab",
      "ArrowRight",
      "ArrowLeft",
    ];

    if (noopKeys.includes(e.key)) {
      e.preventDefault();
    } else {
      switch (e.key) {
        case "Backspace":
          Backspace();
          break;
        case "Enter":
          if (input !== code.slice(0, input.length)) {
            return;
          }
          Enter();
          if (!startTime) {
            setStartTime(new Date());
          }
          break;
        default:
          if (input !== code.slice(0, input.length)) {
            return;
          }
          Key(e);
          if (!startTime) {
            setStartTime(new Date());
          }
          break;
      }
    }
    const lines = input.split("\n");
    setCurrentLineNumber(lines.length);
    setCurrentCharPosition(lines[lines.length - 1].length);
    setReplayTimeStamp((prev) => [
      ...prev,
      {
        char: currentChar,
        textIndicatorPosition,
        currentLineNumber,
        currentCharPosition,
        errors,
        totalErrors,
        time: Date.now(),
      },
    ]);
  }

  function Backspace() {
    if (textIndicatorPosition === input.length) {
      setInput((prevInput) => prevInput.slice(0, -1));
    }

    setTextIndicatorPosition(
      (prevTextIndicatorPosition) => prevTextIndicatorPosition - 1,
    );

    if (raceTimeStamp.length > 0 && errors.length == 0) {
      setRaceTimeStamp((prev) => prev.slice(0, -1));
    }
  }

  function Enter() {
    const lines = code.split("\n");
    if (
      input === code.slice(0, input.length) &&
      code.charAt(input.length) === "\n"
    ) {
      let indent = "";
      let i = 0;
      while (lines[currentLineNumber].charAt(i) === " ") {
        indent += " ";
        i++;
      }

      setInput(input + "\n" + indent);
      setTextIndicatorPosition((prevTextIndicatorPosition) => {
        if (typeof prevTextIndicatorPosition === "number") {
          return prevTextIndicatorPosition + 1 + indent.length;
        } else {
          return prevTextIndicatorPosition;
        }
      });
    } else {
      setInput(input + "\n");
      setTextIndicatorPosition((prevTextIndicatorPosition) => {
        if (typeof prevTextIndicatorPosition === "number") {
          return prevTextIndicatorPosition + 1;
        } else {
          return prevTextIndicatorPosition;
        }
      });
    }
  }

  function Key(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== code.slice(input.length, input.length + 1)) {
      setTotalErrors((prevTotalErrors) => prevTotalErrors + 1);
    }

    if (e.key === code[input.length] && errors.length === 0 && e.key !== " ") {
      const currTime = Date.now();
      const timeTaken = startTime ? (currTime - startTime.getTime()) / 1000 : 0;
      setRaceTimeStamp((prev) => [
        ...prev,
        {
          char: e.key,
          accuracy: calculateAccuracy(input.length, totalErrors),
          cpm: calculateCPM(input.length, timeTaken),
          time: currTime,
        },
      ]);
      setCurrentChar("");
    }

    setInput((prevInput) => prevInput + e.key);
    setTextIndicatorPosition(
      (prevTextIndicatorPosition) => prevTextIndicatorPosition + 1,
    );
  }

  function handleRestart() {
    setStartTime(null);
    setInput("");
    setTextIndicatorPosition(0);
    setTotalErrors(0);
  }

  return (
    <>
      {/* Debug purposes */}
      {/* <pre className="max-w-sm rounded p-8"> */}
      {/*   {JSON.stringify( */}
      {/*     { */}
      {/*       participantId, */}
      {/*       user, */}
      {/*       isRaceFinished, */}
      {/*       raceStatus, */}
      {/*       participants, */}
      {/*       position, */}
      {/*     }, */}
      {/*     null, */}
      {/*     4, */}
      {/*   )} */}
      {/* </pre> */}
      <div
        className="relative flex flex-col gap-2 p-4 rounded-md lg:p-8 bg-accent w-3/4 mx-auto"
        onClick={() => {
          inputElement.current?.focus();
        }}
        role="none" // eslint fix - will remove the semantic meaning of an element while still exposing it to assistive technology
      >
        {/* <p>participant id: {participantId}</p> */}
        {raceId && raceStatus != RaceStatus.RUNNING && !startTime && (
          <MultiplayerLoadingLobby participants={participants}>
            {raceStatus === RaceStatus.WAITING && (
              <div className="flex flex-col items-center text-2xl font-bold">
                <div className="w-8 h-8 border-4 border-muted-foreground rounded-full border-t-4 border-t-warning animate-spin"></div>
                Waiting for players
              </div>
            )}
            {raceStatus === RaceStatus.COUNTDOWN &&
              !startTime &&
              Boolean(raceStartCountdown) && (
                <div className="text-center text-2xl font-bold">
                  Game starting in: {raceStartCountdown}
                </div>
              )}
          </MultiplayerLoadingLobby>
        )}
        {raceStatus === RaceStatus.RUNNING && (
          <>
            {raceId ? (
              participants.map((p) => (
                <RaceTracker
                  key={p.id}
                  position={p.position}
                  participantId={p.id}
                />
              ))
            ) : (
              <RaceTracker position={position} user={user} />
            )}
            <div className="mb-2 md:mb-4 flex justify-between">
              <Heading
                title="Type this code"
                description="Start typing to get racing"
              />
              {user && (
                <ReportButton
                  snippetId={snippet.id}
                  // userId={user.id}
                  language={snippet.language}
                  handleRestart={handleRestart}
                />
              )}
            </div>
            <div className="flex ">
              <div className="flex-col px-1 w-10 ">
                {code.split("\n").map((_, line) => (
                  <div
                    key={line}
                    className={
                      currentLineNumber === line + 1
                        ? "text-center bg-slate-600 text-white  border-r-2 border-yellow-500"
                        : " text-center border-r-2 border-yellow-500"
                    }
                  >
                    {line + 1}
                  </div>
                ))}
              </div>

              <Code
                code={code}
                userInput={input}
                textIndicatorPosition={textIndicatorPosition}
                errors={errors}
              />
              <input
                type="text"
                defaultValue={input}
                ref={inputElement}
                onKeyDown={handleKeyboardDownEvent}
                disabled={isRaceFinished}
                className="absolute inset-y-0 left-0 w-full h-full p-8 rounded-md -z-40 focus:outline outline-blue-500 cursor-none"
                onPaste={(e) => e.preventDefault()}
              />
            </div>
          </>
        )}
        {errors.length > 0 ? (
          <span className="text-red-500">
            You must fix all errors before you can finish the race!
          </span>
        ) : null}
        {raceStatus === RaceStatus.FINISHED && (
          // <h2 className="text-2xl p-4">Loading race results, please wait...</h2>
          <div className="flex flex-col items-center text-2xl font-bold space-y-8">
            <div className="w-8 h-8 border-4 border-muted-foreground rounded-full border-t-4 border-t-warning animate-spin"></div>
            Loading race results, please wait...
          </div>
        )}
        <div className="flex justify-between items-center">
          {showRaceTimer && (
            <>
              <RaceTimer />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" onClick={handleRestart}>
                      Restart (ESC)
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Press Esc to reset</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          )}
        </div>
      </div>
      <RaceDetails submittingResults={submittingResults} />
    </>
  );
}
