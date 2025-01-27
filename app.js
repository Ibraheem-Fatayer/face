// Configuration
const CONFIG = {
    FRAMES_REQUIRED: 3,
    MIN_FRAME_INTERVAL: 200,  // Minimum time between frames in ms
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    SESSION_TIMEOUT: 30000,   // 30 seconds
    DEBUG: true,
    MIN_LIVENESS_CONFIDENCE: 0.6,  // Minimum confidence for liveness
    CAMERA: {
        MIN_WIDTH: 640,
        MIN_HEIGHT: 480,
        IDEAL_WIDTH: 1280,
        IDEAL_HEIGHT: 720,
        MAX_WIDTH: 1920,
        MAX_HEIGHT: 1080
    }
};

// Authentication states
const AUTH_STATE = {
    WAITING: 'waiting',
    ANALYZING: 'analyzing',
    AUTHENTICATED: 'authenticated',
    ERROR: 'error'
};

// Enhanced debug logging
const debug = {
    log: (message, data = null) => {
        if (!CONFIG.DEBUG) return;
        
        const timestamp = new Date().toISOString();
        console.log(`[Debug ${timestamp}] ${message}`, data || '');
        
        const debugPanel = document.getElementById('debugPanel');
        if (debugPanel) {
            const logEntry = document.createElement('div');
            logEntry.className = 'debug-entry';
            logEntry.textContent = `${message} ${data ? JSON.stringify(data) : ''}`;
            debugPanel.insertBefore(logEntry, debugPanel.firstChild);
            
            // Keep only last 5 entries
            while (debugPanel.children.length > 5) {
                debugPanel.removeChild(debugPanel.lastChild);
            }
        }
    },
    error: (message, error) => {
        if (!CONFIG.DEBUG) return;
        console.error(`[Error] ${message}`, error);
        debug.log(`Error: ${message}`, error);
    }
};

// Global state management
const state = {
    isRunning: false,
    isProcessing: false,
    currentState: AUTH_STATE.WAITING,
    framesCollected: 0,
    stream: null,
    lastProcessedTime: 0,
    sessionTimer: null,
    lastUIUpdate: 0,
    ovalState: {
        current: 'no-face',
        transitioning: false,
        lastUpdate: 0
    },
    sessionId: null
};

// DOM Elements
const elements = {
    video: null,
    canvas: null,
    ctx: null,
    statusDisplay: null,
    statusHint: null,
    ovalBorder: null
};

// Initialize DOM elements
async function initializeElements() {
    try {
        elements.video = document.getElementById('video');
        elements.canvas = document.getElementById('canvas');
        elements.statusDisplay = document.getElementById('status');
        elements.statusHint = document.getElementById('statusHint');
        elements.ovalBorder = document.querySelector('.oval-border');

        // Verify all elements exist
        const missingElements = Object.entries(elements)
            .filter(([key, value]) => !value && key !== 'ctx')
            .map(([key]) => key);

        if (missingElements.length > 0) {
            throw new Error(`Missing required elements: ${missingElements.join(', ')}`);
        }

        // Initialize canvas context
        elements.ctx = elements.canvas.getContext('2d');
        if (!elements.ctx) {
            throw new Error('Failed to get canvas context');
        }

        debug.log('All elements initialized successfully');
        return true;
    } catch (error) {
        debug.error('Element initialization failed:', error);
        showError(`Initialization Error: ${error.message}. Please refresh the page.`);
        return false;
    }
}

// Show error message
function showError(message) {
    const errorMessage = document.createElement('div');
    errorMessage.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255, 0, 0, 0.8);
        color: white;
        padding: 20px;
        border-radius: 5px;
        text-align: center;
        z-index: 9999;
    `;
    errorMessage.textContent = message;
    document.body.appendChild(errorMessage);
}

// Initialize application
async function initializeApp() {
    if (await initializeElements()) {
        await startCamera();
        if (CONFIG.DEBUG) {
            initializeDebugPanel();
        }
    }
}

// Start camera with optimal settings
async function startCamera() {
    try {
        if (state.isRunning) return;
        
        const constraints = {
            video: {
                facingMode: 'user',
                width: { 
                    min: CONFIG.CAMERA.MIN_WIDTH,
                    ideal: CONFIG.CAMERA.IDEAL_WIDTH,
                    max: CONFIG.CAMERA.MAX_WIDTH
                },
                height: { 
                    min: CONFIG.CAMERA.MIN_HEIGHT,
                    ideal: CONFIG.CAMERA.IDEAL_HEIGHT,
                    max: CONFIG.CAMERA.MAX_HEIGHT
                },
                aspectRatio: { ideal: window.innerHeight > window.innerWidth ? 3/4 : 4/3 }
            }
        };
        
        debug.log('Requesting camera with constraints:', constraints);
        state.stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        const videoTrack = state.stream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        debug.log('Camera settings:', settings);
        
        elements.video.srcObject = state.stream;
        elements.video.setAttribute('playsinline', true);
        
        await new Promise((resolve) => {
            elements.video.onloadedmetadata = () => {
                debug.log('Video metadata loaded:', {
                    videoWidth: elements.video.videoWidth,
                    videoHeight: elements.video.videoHeight
                });
                elements.video.play();
                resolve();
            };
        });
        
        // Wait for video to stabilize
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Start session
        state.isRunning = true;
        state.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await updateUI(AUTH_STATE.WAITING, 'Position your face in the oval');
        processFrame();
        
    } catch (error) {
        debug.error('Camera initialization error:', error);
        await updateUI(AUTH_STATE.ERROR, 'Camera access denied', 'Please allow camera access and refresh');
    }
}

// Add debug panel
function initializeDebugPanel() {
    const debugPanel = document.createElement('div');
    debugPanel.id = 'debugPanel';
    debugPanel.className = 'debug-panel';
    document.body.appendChild(debugPanel);
}

// Start initialization when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);

// Core UI update function
async function updateUI(newState, message = '', hint = '') {
    if (state.currentState === AUTH_STATE.AUTHENTICATED) {
        return;
    }

    const now = Date.now();
    if (now - state.lastUIUpdate < 300) {
        return;
    }
    state.lastUIUpdate = now;

    if (state.ovalState.transitioning) {
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    state.ovalState.transitioning = true;

    try {
        // Remove previous state
        elements.ovalBorder.classList.remove('analyzing', 'success', 'no-face', 'detected', 'error');
        elements.statusDisplay.classList.remove('analyzing', 'success', 'error', 'no-face', 'visible');

        // Wait for transition
        await new Promise(resolve => setTimeout(resolve, 50));

        // Update state-specific UI
        let newOvalState = '';
        switch (newState) {
            case AUTH_STATE.ANALYZING:
                newOvalState = 'analyzing';
                elements.ovalBorder.classList.add('analyzing');
                elements.statusDisplay.classList.add('analyzing', 'visible');
                break;

            case AUTH_STATE.AUTHENTICATED:
                newOvalState = 'success';
                elements.ovalBorder.classList.add('success');
                elements.statusDisplay.classList.add('success', 'visible');
                break;

            case AUTH_STATE.ERROR:
                newOvalState = 'error';
                elements.ovalBorder.classList.add('error');
                elements.statusDisplay.classList.add('error', 'visible');
                break;

            case AUTH_STATE.WAITING:
            default:
                newOvalState = message.includes('Processing') ? 'detected' : 'no-face';
                elements.ovalBorder.classList.add(newOvalState);
                elements.statusDisplay.classList.add('visible');
                break;
        }

        // Update state and messages
        state.ovalState.current = newOvalState;
        state.ovalState.lastUpdate = now;
        elements.statusDisplay.textContent = message || 'Position your face in the oval';
        elements.statusHint.textContent = hint || '';
        state.currentState = newState;

        await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
        state.ovalState.transitioning = false;
    }
}

// Calculate head size ratio relative to oval
function calculateHeadSizeRatio(ovalData, faceRect) {
    if (!faceRect) return 0;
    
    // Calculate the area of the oval and face rectangle
    const ovalArea = Math.PI * (ovalData.width / 2) * (ovalData.height / 2);
    const faceArea = faceRect.width * faceRect.height;
    
    // Calculate ratio of face area to oval area
    const ratio = faceArea / ovalArea;
    debug.log('Head size ratio:', ratio);
    
    return ratio;
}

// Dynamic face position checking with improved size calculation
function checkFacePosition(ovalData, faceRect) {
    if (!faceRect) {
        debug.log('No face rectangle data available');
        return { isValid: false, message: 'No face detected' };
    }
    
    // Calculate centers
    const ovalCenterX = ovalData.x + ovalData.width / 2;
    const ovalCenterY = ovalData.y + ovalData.height / 2;
    const faceCenterX = faceRect.x + faceRect.width / 2;
    const faceCenterY = faceRect.y + faceRect.height / 2;
    
    // Calculate distances as percentages of oval dimensions
    const xDistancePercent = Math.abs(faceCenterX - ovalCenterX) / (ovalData.width / 2) * 100;
    const yDistancePercent = Math.abs(faceCenterY - ovalCenterY) / (ovalData.height / 2) * 100;
    
    // Calculate face-to-oval ratio using area comparison
    const ovalArea = Math.PI * (ovalData.width / 2) * (ovalData.height / 2);
    const faceArea = faceRect.width * faceRect.height;
    const areaRatio = faceArea / ovalArea;
    
    debug.log('Position check details:', {
        centers: {
            oval: { x: ovalCenterX, y: ovalCenterY },
            face: { x: faceCenterX, y: faceCenterY }
        },
        distances: {
            xPercent: xDistancePercent.toFixed(2) + '%',
            yPercent: yDistancePercent.toFixed(2) + '%'
        },
        areas: {
            oval: ovalArea.toFixed(2),
            face: faceArea.toFixed(2),
            ratio: areaRatio.toFixed(3)
        },
        dimensions: {
            oval: { w: ovalData.width, h: ovalData.height },
            face: { w: faceRect.width, h: faceRect.height }
        }
    });
    
    // More tolerant thresholds
    const maxDistancePercent = 50; // Increased from 40/45
    const minAreaRatio = 0.15;     // Decreased from 0.3
    const maxAreaRatio = 0.85;     // Decreased from 0.95
    
    debug.log('Thresholds:', {
        maxDistance: maxDistancePercent + '%',
        areaRatio: {
            min: minAreaRatio,
            max: maxAreaRatio,
            current: areaRatio
        }
    });
    
    // Position checks with more tolerance
    if (xDistancePercent > maxDistancePercent) {
        const direction = faceCenterX < ovalCenterX ? 'right' : 'left';
        return { isValid: false, message: `Move your face ${direction}` };
    }
    
    if (yDistancePercent > maxDistancePercent) {
        const direction = faceCenterY < ovalCenterY ? 'down' : 'up';
        return { isValid: false, message: `Move your face ${direction}` };
    }
    
    // Size checks using area ratio
    if (areaRatio < minAreaRatio) {
        debug.log('Face too small', { areaRatio, threshold: minAreaRatio });
        return { isValid: false, message: 'Move closer to the camera' };
    }
    
    if (areaRatio > maxAreaRatio) {
        debug.log('Face too large', { areaRatio, threshold: maxAreaRatio });
        return { isValid: false, message: 'Move back from the camera' };
    }
    
    debug.log('Face position valid', {
        areaRatio,
        xDistancePercent,
        yDistancePercent
    });
    
    return { isValid: true, message: 'Face position is good' };
}

// Enhanced capture frame with dynamic calculations
async function captureFrame() {
    debug.log('Starting frame capture');
    
    if (!elements.video.videoWidth || !elements.video.videoHeight) {
        debug.error('Video dimensions not available', {
            videoElement: elements.video,
            readyState: elements.video.readyState
        });
        throw new Error('Video dimensions not available');
    }
    
    // Calculate optimal dimensions based on video aspect ratio
    const videoAspectRatio = elements.video.videoWidth / elements.video.videoHeight;
    debug.log('Video aspect ratio:', videoAspectRatio);
    
    elements.canvas.width = elements.video.videoWidth;
    elements.canvas.height = elements.video.videoHeight;
    
    try {
        elements.ctx.drawImage(elements.video, 0, 0);
    } catch (error) {
        debug.error('Failed to draw video to canvas', error);
        throw error;
    }
    
    const ovalGuide = elements.ovalBorder;
    const videoRect = elements.video.getBoundingClientRect();
    const ovalRect = ovalGuide.getBoundingClientRect();
    
    // Calculate dynamic padding based on screen size
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const screenAspectRatio = screenWidth / screenHeight;
    
    // Dynamic padding calculation (smaller padding for smaller screens)
    const basePadding = Math.min(screenWidth, screenHeight) < 768 ? 0.05 : 0.1;
    const dynamicPadding = basePadding * (screenAspectRatio > 1 ? 1 : screenAspectRatio);
    
    debug.log('Screen dimensions:', {
        width: screenWidth,
        height: screenHeight,
        aspectRatio: screenAspectRatio,
        dynamicPadding
    });
    
    // Calculate scale factors
    const scaleX = elements.video.videoWidth / videoRect.width;
    const scaleY = elements.video.videoHeight / videoRect.height;
    
    // Calculate oval dimensions in video coordinates
    const ovalData = {
        x: Math.round((ovalRect.left - videoRect.left) * scaleX),
        y: Math.round((ovalRect.top - videoRect.top) * scaleY),
        width: Math.round(ovalRect.width * scaleX * (1 + dynamicPadding)),
        height: Math.round(ovalRect.height * scaleY * (1 + dynamicPadding))
    };
    
    debug.log('Oval calculations:', {
        scaleFactors: { scaleX, scaleY },
        ovalRect,
        videoRect,
        calculatedOval: ovalData
    });
    
    const imageData = elements.canvas.toDataURL('image/jpeg', 0.9);
    return { imageData, ovalData };
}

// Enhanced process frame with better liveness handling
async function processFrame() {
    if (!state.isRunning || state.isProcessing) {
        debug.log('Skipping frame processing', { isRunning: state.isRunning, isProcessing: state.isProcessing });
        return;
    }
    
    state.isProcessing = true;
    debug.log('Starting frame processing');
    
    try {
        const currentTime = Date.now();
        if (currentTime - state.lastProcessedTime < CONFIG.MIN_FRAME_INTERVAL) {
            state.isProcessing = false;
            if (state.isRunning) {
                setTimeout(() => requestAnimationFrame(processFrame), CONFIG.MIN_FRAME_INTERVAL);
            }
            debug.log('Frame skipped due to interval limit');
            return;
        }

        const { imageData, ovalData } = await captureFrame();
        debug.log('Frame captured successfully', { ovalData });
        
        // const response = await fetch('192.168.3.211:5000/api/authenticate', {
        //     method: 'POST',
        //     headers: { 
        //         'Content-Type': 'application/json'
        //     },
        //     body: JSON.stringify({ 
        //         image: imageData, 
        //         oval_guide: ovalData,
        //         session_id: state.sessionId
        //     })
        // });

        // if (!response.ok) {
        //     throw new Error(`HTTP error! status: ${response.status}`);
        // }

        // const result = await response.json();
        // debug.log('Raw API response:', result);
        
        // if (result.success) {
        //     if (result.face_detected) {
        //         // Create face rect if missing
        //         if (!result.face_rect) {
        //             debug.log('Face detected but no face_rect provided, using estimated position');
        //             result.face_rect = {
        //                 x: ovalData.x + ovalData.width * 0.25,
        //                 y: ovalData.y + ovalData.height * 0.25,
        //                 width: ovalData.width * 0.5,
        //                 height: ovalData.height * 0.5
        //             };
        //         }
                
        //         debug.log('Face detected with rect:', result.face_rect);
        //         const positionCheck = checkFacePosition(ovalData, result.face_rect);
        //         debug.log('Position check result:', positionCheck);
                
        //         if (positionCheck.isValid) {
        //             // Check if we need to move closer or further based on the message
        //             if (result.message && result.message.toLowerCase().includes('closer')) {
        //                 state.framesCollected = 0;
        //                 await updateUI(AUTH_STATE.WAITING, 'Move closer to the camera');
        //                 debug.log('Need to move closer');
        //             } else if (result.message && result.message.toLowerCase().includes('further')) {
        //                 state.framesCollected = 0;
        //                 await updateUI(AUTH_STATE.WAITING, 'Move further from the camera');
        //                 debug.log('Need to move further');
        //             } else {
        //                 // Position is good, check liveness
        //                 const confidence = parseFloat(result.confidence) || 0;
        //                 debug.log('Checking liveness', { confidence, required: CONFIG.MIN_LIVENESS_CONFIDENCE });
                        
        //                 if (confidence >= CONFIG.MIN_LIVENESS_CONFIDENCE) {
        //                     state.framesCollected++;
        //                     debug.log('Valid frame collected', { 
        //                         framesCollected: state.framesCollected,
        //                         confidence,
        //                         required: CONFIG.FRAMES_REQUIRED
        //                     });
                            
        //                     if (state.framesCollected >= CONFIG.FRAMES_REQUIRED) {
        //                         if (result.recognized_name) {
        //                             await handleSuccessfulAuthentication(result.recognized_name);
        //                             return;
        //                         } else {
        //                             await updateUI(AUTH_STATE.ERROR, 'Face not recognized');
        //                             state.framesCollected = 0;
        //                         }
        //                     } else {
        //                         await updateUI(AUTH_STATE.ANALYZING, 'Verifying...', 
        //                             `Keep still (${state.framesCollected}/${CONFIG.FRAMES_REQUIRED})`);
        //                     }
        //                 } else {
        //                     state.framesCollected = 0;
        //                     await updateUI(AUTH_STATE.WAITING, 'Keep your face still');
        //                     debug.log('Liveness check failed', { confidence });
        //                 }
        //             }
        //         } else {
        //             state.framesCollected = 0;
        //             await updateUI(AUTH_STATE.WAITING, positionCheck.message);
        //         }
        //     } else {
        //         state.framesCollected = 0;
        //         await updateUI(AUTH_STATE.WAITING, 'Position your face in the oval');
        //         debug.log('No face detected in frame');
        //     }
        // } else {
        //     debug.error('API returned error', result);
        //     state.framesCollected = 0;
        //     await updateUI(AUTH_STATE.ERROR, result.message || 'Error processing frame');
        // }

        // state.lastProcessedTime = currentTime;
        // state.isProcessing = false;

        // if (state.isRunning && 
        //     state.currentState !== AUTH_STATE.AUTHENTICATED && 
        //     state.framesCollected < CONFIG.FRAMES_REQUIRED) {
        //     setTimeout(() => requestAnimationFrame(processFrame), CONFIG.MIN_FRAME_INTERVAL);
        // }

    } catch (error) {
        debug.error('Frame processing error:', error);
        state.framesCollected = 0;
        await updateUI(AUTH_STATE.ERROR, 'Error processing frame');
        state.isProcessing = false;

        if (state.isRunning && state.currentState !== AUTH_STATE.AUTHENTICATED) {
            setTimeout(() => requestAnimationFrame(processFrame), CONFIG.RETRY_DELAY);
        }
    }
}

// Handle successful authentication
async function handleSuccessfulAuthentication(name) {
    if (!name) {
        debug.error('Cannot handle authentication: name is undefined');
        return;
    }
    
    state.isRunning = false;
    state.isProcessing = false;
    
    const firstName = name.split(' ')[0];
    await updateUI(AUTH_STATE.AUTHENTICATED, `Welcome, ${firstName}!`);
    
    if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
    }
    
    // Notify parent application
    if (window.flutter_inappwebview) {
        window.flutter_inappwebview.callHandler('authenticationComplete', {
            status: 'success',
            name: name,
            message: 'Authentication successful',
            timestamp: Date.now()
        });
    }
}