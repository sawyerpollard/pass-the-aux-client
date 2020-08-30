/* eslint-disable react/prop-types */
import React, { useState, useEffect } from "react";
import "../styles/styles.css";
import SEO from "../components/seo.jsx"

import SearchBar from "../components/searchbar.jsx";
import Player from "../components/player.jsx";
import Queue from "../components/queue.jsx";
import Chat from "../components/chat.jsx";
import Header from "../components/header.jsx";
import { Modal, modals } from "../components/modal.jsx"
import { addToQueue, startSong, pauseSong, resumeSong, nextSong, previousSong, getDevices, getAccessToken, enterRoom, setSongPosition, getCurrentPlaybackState } from "../api.js"
import { addSDKScript, isPlaybackCapable, initPlayer } from "../web_playback.js";
const Nes = require("@hapi/nes/lib/client")

const App = () => {
  const [songs, updateSongs] = useState([]);
  const [history, setHistory] = useState([]);
  const [isPaused, setIsPaused] = useState(true);

  const [isAuthorized, setIsAuthorized] = useState(false);
  const [playbackCapable, setPlaybackCapable] = useState(true);

  const [signInLink, setSignInLink] = useState(null);
  const [seekUpdateElapsed, setSeekUpdateElapsed] = useState(0);
  const [room, setRoom] = useState("");
  const [WSClient, setWSClient] = useState(null);

  const [device, setDevice] = useState(null);
  const [deviceSearching, setDeviceSearching] = useState(true);
  
  const [queueVisible, setQueueVisible] = useState(true);
  const [modalBody, setModalBody] = useState("");
  const [showModal, setShowModal] = useState(false);
  const closeModal = () => setShowModal(false);
  
  const songInQueue = songs.length > 0; // bool that is true if there is a song in the queue

  /* Initialization function that fires on mount
    If the user is signed in, sets up the approproiate device connection, otherwise prompts them to log in */
  useEffect(() => {
    const isAuthorized = document.cookie === "isAuthorized=true";
    const playbackCapable = isPlaybackCapable();
    const queryParams = new URLSearchParams(window.location.search);
    const room = queryParams.get("room");
    
    if (isAuthorized && playbackCapable) {
      setupWebPlayer();
    }
    else if (isAuthorized && !playbackCapable) {
      setupRemoteDevice();
    }
    else {
      const playbackQuery = playbackCapable ? '?wantsWebPlayback=true' : "";
      const roomQuery = room ? `&room=${room}` : "";
      setSignInLink(`http://localhost:3000/auth/spotify${playbackQuery}${roomQuery}`);
    }

    startRefreshTimer();
    setIsAuthorized(isAuthorized);
    setPlaybackCapable(playbackCapable);
    setRoom(room);
  }, []);

  /* Fires after the sign in link has been set with the query params it needs (room ID and playback capability) */
  useEffect(() => {
    if (signInLink) {
      setModalBody(modals.SignIn);
      setShowModal(true);
    }
  }, [signInLink]);

  /* Fires after the user is authorized, connected to a device, and in a room */
  useEffect(() => {
    if (isAuthorized && device && room) {
      initRoomSocket().then(async (msg) => {
        const playback = await getCurrentPlaybackState(room);
        await loadPlaybackLocally(playback);
      });
    }

    /* Functions needed to do this effect included here in the callback body */
    async function initRoomSocket() {
      console.log('entering room', room, 'with device ', device.id);
      const { msg } = await enterRoom(room);
      if (msg === "error") {
        setShowModal(true);
        setModalBody(modals.RoomNotFound);
        window.history.pushState(null, null, "/");
        throw new Error("room-not-found");
      }
      else {
        console.log("connecting to websocket in room", room)
        const client = new Nes.Client("ws://localhost:3000");
        await client.connect();
        client.subscribe(`/rooms/playback/${room}`, handleRoomPlaybackUpdate);
        setWSClient(client);
      }
    }

    async function loadPlaybackLocally(playback) {
      const {isPaused, position_ms, queue, history, current_song} = playback;
      //queue.forEach(async (song) => await addToQueue(device.id, song, room, false));
  
      if (current_song && !isPaused && Object.keys(current_song).length !== 0) {
        await startSong(device.id, current_song, room, false);
        await setSongPosition(device.id, position_ms, room, false);
        setSeekUpdateElapsed(position_ms);
      }
  
      setIsPaused(isPaused);
      setHistory([...history]);
      updateSongs([...queue]);
    }

    /* Function that fires whenever the user receives a web socket message
    Updates the local state and the user's spotify playback with relevant info */
    async function handleRoomPlaybackUpdate({ updated, type }) {
      console.log(updated, type);
      switch(type) {
        case 'start':
          console.log('received update to start')
          await startSong(device.id, updated.current_song, room, false);
          updateSongs(songs => songs.concat(updated.current_song));
          setIsPaused(false);
          break;
        case 'resume':
          await resumeSong(device.id, room, false);
          setIsPaused(false);
          break;
        case 'pause':
          await pauseSong(device.id, room, false);
          setIsPaused(true);
          break;
        case 'next':
          console.log('next song from room update')
          await nextSong(device.id, updated.current_song, room, false);
          updateSongs(songs => songs.filter((s, i) => i > 0));
          setIsPaused(false);
          break;
        case 'previous':
          await previousSong(device.id, updated.current_song, room, false);
          updateSongs(songs => {
            const updated = [...songs];
            updated[0] = history[history.length - 1];
            return updated;
          });
          setIsPaused(false);
          break;
        case 'queue':
          await addToQueue(device.id, updated.current_song, room, false);
          updateSongs(songs => songs.concat(updated.current_song));
          break;
        case 'seek':
          const position = parseInt(updated.position_ms);
          await setSongPosition(device.id, position, room, false);
          setSeekUpdateElapsed(position / 1000);
          break;
        default: break;
      }
    }
  }, [isAuthorized, device, room]);

  const setupWebPlayer = async () => {
    addSDKScript();
    const playerData = await initPlayer();

    setShowModal(false);
    setDeviceSearching(false);
    setDevice(playerData.device);
  }

  const setupRemoteDevice = () => {
    setModalBody(modals.DeviceSearch);

    //every 2 seconds, check if there are any active devices, and if so, set it as the device
    const searchForDevices = setInterval(() => {
      getDevices().then(devices => {
        if (devices && devices.length > 0) {
          setDevice(devices[0]);
          setDeviceSearching(false);
          clearInterval(searchForDevices);
        }
      });
    }, 1000)
  }

  const startRefreshTimer = () => {
    // refresh the access token roughly every hour if the user has not left the page
    const almost_one_hour = 55 * 60000; // 55 mins
    setInterval(() => {
      getAccessToken();
    }, almost_one_hour);
  }

  return (
    <>
      <SEO title="App" />
      <Modal body={modalBody} loading={deviceSearching} deviceName={device? device.name : ""}
        showDialog={showModal} close={closeModal} mobile={false} apiLink={signInLink} />
      <div className="flex flex-col w-screen h-screen bg-bgColor text-text overflow-hidden">
        <Header device={device} deviceSearching={deviceSearching} signInLink={signInLink} room={room} setRoom={setRoom}/>
        <div className="container flex flex-col flex-grow mx-auto my-4 px-5 overflow-y-auto h-full scrollbar" style={{height: '85%'}}>
          <SearchBar songs={songs} room={room} device={device} updateSongs={updateSongs} setIsPaused={setIsPaused} />
          <div className="flex h-full ">
              <Queue songs={songs} setQueueVisible={setQueueVisible} queueVisible={queueVisible}/>
              <Chat room={room} client={WSClient} setQueueVisible={setQueueVisible} queueVisible={queueVisible} authorized={isAuthorized}/>
          </div>
        </div>
        <Player songInQueue={songInQueue} isPaused={isPaused} songs={songs} history={history} room={room} device={device} updateSongs={updateSongs}
          playbackCapable={playbackCapable} seekElapsed={seekUpdateElapsed} setHistory={setHistory} setIsPaused={setIsPaused}/>
      </div>
    </>
  );
};

export default App;
