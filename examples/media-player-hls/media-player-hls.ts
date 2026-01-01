/**
 * HLS Media Player Example using mediabunny's HlsInput (SuperInput pattern).
 * This version uses the new simplified HLS API.
 */
import {
	HlsInput,
	HlsVariant,
	CanvasSink,
	AudioBufferSink,
	WrappedAudioBuffer,
	WrappedCanvas,
} from 'mediabunny';

// Sample HLS stream (Apple's fMP4 HLS test stream with muxed audio)
const SAMPLE_HLS_URL
	= 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';

const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const loadSampleButton = document.querySelector('#load-sample') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const qualitySelector = document.querySelector('#quality-selector') as HTMLDivElement;
const loadingElement = document.querySelector('#loading-element') as HTMLParagraphElement;
const playerContainer = document.querySelector('#player') as HTMLDivElement;
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const controlsElement = document.querySelector('#controls') as HTMLDivElement;
const playButton = document.querySelector('#play-button') as HTMLButtonElement;
const playIcon = document.querySelector('#play-icon') as HTMLSpanElement;
const pauseIcon = document.querySelector('#pause-icon') as HTMLSpanElement;
const currentTimeElement = document.querySelector('#current-time') as HTMLSpanElement;
const durationElement = document.querySelector('#duration') as HTMLSpanElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const volumeBarContainer = document.querySelector('#volume-bar-container') as HTMLDivElement;
const volumeBar = document.querySelector('#volume-bar') as HTMLDivElement;
const volumeIconWrapper = document.querySelector('#volume-icon-wrapper') as HTMLDivElement;
const volumeButton = document.querySelector('#volume-button') as HTMLButtonElement;
const fullscreenButton = document.querySelector('#fullscreen-button') as HTMLButtonElement;
const errorElement = document.querySelector('#error-element') as HTMLDivElement;
const warningElement = document.querySelector('#warning-element') as HTMLDivElement;
const liveBadge = document.querySelector('#live-badge') as HTMLDivElement;

const context = canvas.getContext('2d')!;

let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;

let fileLoaded = false;
let hlsInput: HlsInput | null = null;
let currentHlsUrl: string | null = null;
let videoSink: CanvasSink | null = null;
let audioSink: AudioBufferSink | null = null;

let totalDuration = 0;
let audioContextStartTime: number | null = null;
let playing = false;
let playbackTimeAtStart = 0;

let videoFrameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
let audioBufferIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
let nextFrame: WrappedCanvas | null = null;
const queuedAudioNodes: Set<AudioBufferSourceNode> = new Set();

let asyncId = 0;

let draggingProgressBar = false;
let volume = 0.7;
let draggingVolumeBar = false;
let volumeMuted = false;

/** === INIT LOGIC === */

const initMediaPlayer = async (hlsUrl: string, selectedVariant?: HlsVariant) => {
	try {
		if (playing) {
			pause();
		}

		void videoFrameIterator?.return();
		void audioBufferIterator?.return();
		asyncId++;

		fileLoaded = false;
		fileNameElement.textContent = hlsUrl;
		horizontalRule.style.display = '';
		loadingElement.style.display = '';
		playerContainer.style.display = 'none';
		liveBadge.style.display = 'none';
		errorElement.textContent = '';
		warningElement.textContent = '';

		// Reuse existing HlsInput if just changing variant on same URL, otherwise create new
		const needNewInput = !hlsInput || hlsInput.disposed || currentHlsUrl !== hlsUrl;
		if (needNewInput) {
			hlsInput?.dispose();
			hlsInput = new HlsInput(hlsUrl);
			currentHlsUrl = hlsUrl;
			qualitySelector.style.display = 'none';
		}

		// Get available variants
		const variants = await hlsInput.getVariants();

		// Show quality selector if multiple variants available (only on first load)
		if (needNewInput && variants.length > 1) {
			showQualitySelector(hlsUrl, variants);
		}

		// Select variant if specified, otherwise use auto-selected (highest)
		if (selectedVariant) {
			await hlsInput.selectVariant(selectedVariant);
		}

		// Get tracks directly from HlsInput
		const videoTrack = await hlsInput.getPrimaryVideoTrack();
		const audioTrack = await hlsInput.getPrimaryAudioTrack();

		console.log('Has video track:', !!videoTrack);
		console.log('Has audio track:', !!audioTrack);

		if (!videoTrack) {
			throw new Error('No video track found');
		}

		playbackTimeAtStart = 0;
		totalDuration = await hlsInput.computeDuration();
		durationElement.textContent = formatSeconds(totalDuration);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
		const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

		audioContext = new AudioContextClass({ sampleRate: audioTrack?.sampleRate });
		gainNode = audioContext.createGain();
		gainNode.connect(audioContext.destination);
		updateVolume();

		videoSink = new CanvasSink(videoTrack, {
			poolSize: 2,
			fit: 'contain',
		});
		audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;

		canvas.width = videoTrack.displayWidth;
		canvas.height = videoTrack.displayHeight;

		if (audioTrack) {
			volumeButton.style.display = '';
			volumeBarContainer.style.display = '';
		} else {
			volumeButton.style.display = 'none';
			volumeBarContainer.style.display = 'none';
		}

		fileLoaded = true;

		await startVideoIterator();

		if (audioContext.state === 'running') {
			await play();
		}

		loadingElement.style.display = 'none';
		playerContainer.style.display = '';

		controlsElement.style.opacity = '1';
		controlsElement.style.pointerEvents = '';
		playerContainer.style.cursor = '';
	} catch (error) {
		console.error(error);
		errorElement.textContent = String(error);
		loadingElement.style.display = 'none';
		playerContainer.style.display = 'none';
	}
};

/** === VIDEO RENDERING LOGIC === */

const startVideoIterator = async () => {
	if (!videoSink) {
		return;
	}

	asyncId++;

	await videoFrameIterator?.return();

	videoFrameIterator = videoSink.canvases(getPlaybackTime());

	const firstFrame = (await videoFrameIterator.next()).value ?? null;
	const secondFrame = (await videoFrameIterator.next()).value ?? null;

	nextFrame = secondFrame;

	if (firstFrame) {
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(firstFrame.canvas, 0, 0, canvas.width, canvas.height);
	}
};

const render = (requestFrame = true) => {
	if (fileLoaded) {
		const playbackTime = getPlaybackTime();

		if (playbackTime >= totalDuration) {
			pause();
			playbackTimeAtStart = totalDuration;
		}

		if (nextFrame && nextFrame.timestamp <= playbackTime) {
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(nextFrame.canvas, 0, 0, canvas.width, canvas.height);
			nextFrame = null;

			void updateNextFrame();
		}

		if (!draggingProgressBar) {
			updateProgressBarTime(playbackTime);
		}
	}

	if (requestFrame) {
		requestAnimationFrame(() => render());
	}
};
render();

setInterval(() => render(false), 500);

const updateNextFrame = async () => {
	const currentAsyncId = asyncId;

	while (true) {
		const newNextFrame = (await videoFrameIterator!.next()).value ?? null;
		if (!newNextFrame) {
			break;
		}

		if (currentAsyncId !== asyncId) {
			break;
		}

		const playbackTime = getPlaybackTime();
		if (newNextFrame.timestamp <= playbackTime) {
			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(newNextFrame.canvas, 0, 0, canvas.width, canvas.height);
		} else {
			nextFrame = newNextFrame;
			break;
		}
	}
};

/** === AUDIO PLAYBACK LOGIC === */

const runAudioIterator = async () => {
	if (!audioSink) {
		console.log('No audio sink available');
		return;
	}

	console.log('Starting audio iterator');
	const currentAsyncId = asyncId;
	let bufferCount = 0;

	for await (const { buffer, timestamp } of audioBufferIterator!) {
		if (currentAsyncId !== asyncId) break;
		if (!playing) break;

		bufferCount++;
		if (bufferCount <= 3) {
			console.log(`Audio buffer ${bufferCount}: timestamp=${timestamp.toFixed(3)}s, duration=${buffer.duration.toFixed(3)}s, channels=${buffer.numberOfChannels}`);
		}

		const node = audioContext!.createBufferSource();
		node.buffer = buffer;
		node.connect(gainNode!);

		const startTimestamp = audioContextStartTime! + timestamp - playbackTimeAtStart;

		if (startTimestamp >= audioContext!.currentTime) {
			node.start(startTimestamp);
		} else {
			const offset = audioContext!.currentTime - startTimestamp;
			if (offset < buffer.duration) {
				node.start(audioContext!.currentTime, offset);
			} else {
				continue;
			}
		}

		queuedAudioNodes.add(node);
		node.onended = () => {
			queuedAudioNodes.delete(node);
		};

		if (timestamp - getPlaybackTime() >= 2) {
			await new Promise<void>((resolve) => {
				const checkInterval = () => {
					if (currentAsyncId !== asyncId || !playing) {
						resolve();
						return;
					}
					if (timestamp - getPlaybackTime() < 1) {
						resolve();
					} else {
						setTimeout(checkInterval, 100);
					}
				};
				setTimeout(checkInterval, 100);
			});
		}
	}
};

/** === PLAYBACK CONTROL LOGIC === */

const getPlaybackTime = () => {
	if (playing) {
		return audioContext!.currentTime - audioContextStartTime! + playbackTimeAtStart;
	} else {
		return playbackTimeAtStart;
	}
};

const play = async () => {
	if (audioContext!.state === 'suspended') {
		await audioContext!.resume();
	}

	if (getPlaybackTime() >= totalDuration) {
		playbackTimeAtStart = 0;
		await startVideoIterator();
	}

	audioContextStartTime = audioContext!.currentTime;
	playing = true;

	if (audioSink) {
		void audioBufferIterator?.return();
		audioBufferIterator = audioSink.buffers(getPlaybackTime());
		runAudioIterator().catch((err) => {
			console.error('Audio iterator error:', err);
		});
	}

	playIcon.style.display = 'none';
	pauseIcon.style.display = '';
};

const pause = () => {
	playbackTimeAtStart = getPlaybackTime();
	playing = false;
	void audioBufferIterator?.return();
	audioBufferIterator = null;

	for (const node of queuedAudioNodes) {
		node.stop();
	}
	queuedAudioNodes.clear();

	playIcon.style.display = '';
	pauseIcon.style.display = 'none';
};

const togglePlay = () => {
	if (playing) {
		pause();
	} else {
		void play();
	}
};

const seekToTime = async (seconds: number) => {
	updateProgressBarTime(seconds);

	const wasPlaying = playing;

	if (wasPlaying) {
		pause();
	}

	playbackTimeAtStart = seconds;

	await startVideoIterator();

	if (wasPlaying && playbackTimeAtStart < totalDuration) {
		void play();
	}
};

/** === QUALITY SELECTOR === */

const showQualitySelector = (hlsUrl: string, variants: HlsVariant[]) => {
	while (qualitySelector.children.length > 1) {
		qualitySelector.removeChild(qualitySelector.lastChild!);
	}

	const sortedVariants = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);

	for (const variant of sortedVariants) {
		const button = document.createElement('button');
		button.className
			= 'rounded bg-zinc-200 dark:bg-zinc-750 hover:bg-zinc-300 dark:hover:bg-zinc-700 px-2 py-1 text-xs';

		const label = variant.resolution
			? `${variant.resolution.height}p`
			: `${Math.round(variant.bandwidth / 1000)}kbps`;

		button.textContent = label;
		button.addEventListener('click', () => {
			void initMediaPlayer(hlsUrl, variant);
		});

		qualitySelector.appendChild(button);
	}

	qualitySelector.style.display = 'flex';
};

/** === PROGRESS BAR LOGIC === */

const updateProgressBarTime = (seconds: number) => {
	if (!isFinite(seconds)) return;
	currentTimeElement.textContent = formatSeconds(seconds);
	progressBar.style.width = `${(seconds / totalDuration) * 100}%`;
};

progressBarContainer.addEventListener('pointerdown', (event) => {
	draggingProgressBar = true;
	progressBarContainer.setPointerCapture(event.pointerId);

	const rect = progressBarContainer.getBoundingClientRect();
	const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	updateProgressBarTime(completion * totalDuration);

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingProgressBar = false;
		progressBarContainer.releasePointerCapture(event.pointerId);

		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		const newTime = completion * totalDuration;

		void seekToTime(newTime);
		showControlsTemporarily();
	}, { once: true });
});

progressBarContainer.addEventListener('pointermove', (event) => {
	if (draggingProgressBar) {
		const rect = progressBarContainer.getBoundingClientRect();
		const completion = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateProgressBarTime(completion * totalDuration);
	}
});

/** === VOLUME CONTROL LOGIC === */

const updateVolume = () => {
	const actualVolume = volumeMuted ? 0 : volume;

	volumeBar.style.width = `${actualVolume * 100}%`;

	if (gainNode) {
		gainNode.gain.value = actualVolume ** 2;
	}

	const iconNumber = volumeMuted ? 0 : Math.ceil(1 + 3 * volume);
	for (let i = 0; i < volumeIconWrapper.children.length; i++) {
		const icon = volumeIconWrapper.children[i] as HTMLImageElement;
		icon.style.display = i === iconNumber ? '' : 'none';
	}
};
updateVolume();

volumeBarContainer.addEventListener('pointerdown', (event) => {
	draggingVolumeBar = true;
	volumeBarContainer.setPointerCapture(event.pointerId);

	const rect = volumeBarContainer.getBoundingClientRect();
	volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
	volumeMuted = false;
	updateVolume();

	clearTimeout(hideControlsTimeout);

	window.addEventListener('pointerup', (event) => {
		draggingVolumeBar = false;
		volumeBarContainer.releasePointerCapture(event.pointerId);

		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();

		showControlsTemporarily();
	}, { once: true });
});

volumeButton.addEventListener('click', () => {
	volumeMuted = !volumeMuted;
	updateVolume();
});

volumeBarContainer.addEventListener('pointermove', (event) => {
	if (draggingVolumeBar) {
		const rect = volumeBarContainer.getBoundingClientRect();
		volume = Math.max(Math.min((event.clientX - rect.left) / rect.width, 1), 0);
		updateVolume();
	}
});

/** === CONTROL UI LOGIC === */

const showControlsTemporarily = () => {
	controlsElement.style.opacity = '1';
	controlsElement.style.pointerEvents = '';
	playerContainer.style.cursor = '';

	clearTimeout(hideControlsTimeout);
	hideControlsTimeout = window.setTimeout(() => {
		if (draggingProgressBar || draggingVolumeBar) {
			return;
		}

		hideControls();
		playerContainer.style.cursor = 'none';
	}, 2000);
};

const hideControls = () => {
	controlsElement.style.opacity = '0';
	controlsElement.style.pointerEvents = 'none';
};
hideControls();

let hideControlsTimeout = -1;
playerContainer.addEventListener('pointermove', (event) => {
	if (event.pointerType !== 'touch') {
		showControlsTemporarily();
	}
});
playerContainer.addEventListener('pointerleave', (event) => {
	if (draggingProgressBar || draggingVolumeBar || event.pointerType === 'touch') {
		return;
	}

	hideControls();
	clearTimeout(hideControlsTimeout);
});

/** === EVENT LISTENERS === */

playButton.addEventListener('click', togglePlay);
window.addEventListener('keydown', (e) => {
	if (!fileLoaded) {
		return;
	}

	if (e.code === 'Space' || e.code === 'KeyK') {
		togglePlay();
	} else if (e.code === 'KeyF') {
		fullscreenButton.click();
	} else if (e.code === 'ArrowLeft') {
		const newTime = Math.max(getPlaybackTime() - 5, 0);
		void seekToTime(newTime);
	} else if (e.code === 'ArrowRight') {
		const newTime = Math.min(getPlaybackTime() + 5, totalDuration);
		void seekToTime(newTime);
	} else if (e.code === 'KeyM') {
		volumeButton.click();
	} else {
		return;
	}

	showControlsTemporarily();
	e.preventDefault();
});

fullscreenButton.addEventListener('click', () => {
	if (document.fullscreenElement) {
		void document.exitFullscreen();
	} else {
		playerContainer.requestFullscreen().catch((e) => {
			console.error('Failed to enter fullscreen mode:', e);
		});
	}
});

const isTouchDevice = () => 'ontouchstart' in window;

playerContainer.addEventListener('click', () => {
	if (isTouchDevice()) {
		if (controlsElement.style.opacity === '1') {
			hideControls();
		} else {
			showControlsTemporarily();
		}
	} else {
		togglePlay();
	}
});
controlsElement.addEventListener('click', (event) => {
	event.stopPropagation();
	showControlsTemporarily();
});

/** === UTILS === */

const formatSeconds = (seconds: number) => {
	if (!isFinite(seconds)) return '--:--';

	const showMilliseconds = window.innerWidth >= 640;
	seconds = Math.round(seconds * 1000) / 1000;

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	const millisecs = Math.floor(1000 * seconds % 1000).toString().padStart(3, '0');

	let result: string;
	if (hours > 0) {
		result = `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
	} else {
		result = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
	}

	if (showMilliseconds) {
		result += `.${millisecs}`;
	}

	return result;
};

window.addEventListener('resize', () => {
	if (totalDuration && isFinite(totalDuration)) {
		updateProgressBarTime(getPlaybackTime());
		durationElement.textContent = formatSeconds(totalDuration);
	}
});

/** === HLS LOAD LOGIC === */

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter an HLS manifest URL (.m3u8). Note that it must be HTTPS and support cross-origin requests '
		+ '(CORS headers). Currently only fMP4 HLS streams are supported (not MPEG-TS).',
	);
	if (!url) {
		return;
	}

	void initMediaPlayer(url);
});

loadSampleButton.addEventListener('click', () => {
	void initMediaPlayer(SAMPLE_HLS_URL);
});
