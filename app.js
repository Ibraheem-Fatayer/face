// Camera elements
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const statusDisplay = document.getElementById('status');
const facePositionGuide = document.getElementById('facePositionGuide');
const processedImageContainer = document.getElementById('processedImageContainer');

// Additional UI elements
const statusHint = document.getElementById('statusHint');
const progressDots = document.getElementById('progressDots').children;

// Debug mode
const DEBUG = true;

// State
let isRunning = false;
let authenticationLoop = null;
let liveFrameCount = 0;
const REQUIRED_LIVE_FRAMES = 5;
const FRAME_INTERVAL = 200;  // Check every 200ms

// Add session timeout constants
const SESSION_TIMEOUT = 10000;  // 10 seconds in milliseconds

// Authentication state
const AUTH_STATE = {
    MONITORING: 'monitoring',
    AUTHENTICATED: 'authenticated',
    TIMEOUT: 'timeout'
};

let sessionTimer = null;
let currentState = AUTH_STATE.MONITORING;
let lastSuccessTime = 0;
let lastStatusUpdate = 0;
const STATUS_DEBOUNCE_TIME = 1000; // 1 second debounce for status changes

// Debug Functions
const debug = {
    log: (message, data = null) => {
        if (DEBUG) {
            if (data !== null) {
                console.log(`[Debug] ${message}`, JSON.stringify(data, null, 2));
            } else {
                console.log(`[Debug] ${message}`);
            }
        }
    },
    error: (message, error) => {
        if (DEBUG) {
            console.error(`[Error] ${message}`, error);
        }
    }
};

// Check if running on localhost or HTTPS
const isLocalhost = window.location.hostname === 'localhost' || 
                   window.location.hostname === '127.0.0.1' ||
                   window.location.hostname === '';
const isSecure = window.location.protocol === 'https:';

// Add overlay elements
document.addEventListener('DOMContentLoaded', () => {
    // Create timeout overlay
    const overlay = document.createElement('div');
    overlay.className = 'timeout-overlay';
    overlay.innerHTML = `
        <div class="timeout-content">
            <h2>Session Timeout</h2>
            <p>Unable to verify face within time limit</p>
            <div class="timeout-buttons">
                <button class="retry-button">Try Again</button>
                <button class="fingerprint-button">Use Fingerprint</button>
                <button class="otp-button">Use OTP</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Add event listeners for buttons
    document.querySelector('.retry-button').addEventListener('click', () => {
        resetSession();
        overlay.classList.remove('active');
    });

    document.querySelector('.fingerprint-button').addEventListener('click', () => {
        notifyFlutter({
            status: 'switch_auth',
            method: 'fingerprint',
            timestamp: Date.now()
        });
    });

    document.querySelector('.otp-button').addEventListener('click', () => {
        notifyFlutter({
            status: 'switch_auth',
            method: 'otp',
            timestamp: Date.now()
        });
    });

    initializeCamera();
});

function startSession() {
    if (sessionTimer) {
        clearTimeout(sessionTimer);
    }
    
    currentState = AUTH_STATE.MONITORING;
    sessionTimer = setTimeout(() => {
        if (currentState !== AUTH_STATE.AUTHENTICATED) {
            handleTimeout();
        }
    }, SESSION_TIMEOUT);
}

function handleTimeout() {
    currentState = AUTH_STATE.TIMEOUT;
    isRunning = false;
    if (authenticationLoop) {
        clearTimeout(authenticationLoop);
        authenticationLoop = null;
    }
    
    document.querySelector('.timeout-overlay').classList.add('active');
    
    // Notify Flutter about timeout
    notifyFlutter({
        status: 'timeout',
        message: 'Face verification timeout',
        timestamp: Date.now()
    });
}

function resetSession() {
    isRunning = true;
    currentState = AUTH_STATE.MONITORING;
    liveFrameCount = 0;
    resetUI();
    startSession();
    startAuthentication();
}

// Initialize camera automatically
async function initializeCamera() {
    try {
        // Check for media devices support
        if (!navigator.mediaDevices) {
            throw new Error('Media devices not supported');
        }

        // More specific error checking
        const supported = 'getUserMedia' in navigator.mediaDevices;
        if (!supported) {
            throw new Error('getUserMedia not supported');
        }

        const constraints = { 
            video: {
                facingMode: "user",  // Use front camera
                aspectRatio: { ideal: 1.333333333 }  // 4:3 aspect ratio
            },
            audio: false
        };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                resolve();
            };
        });
        
        await video.play();
        isRunning = true;
        currentState = AUTH_STATE.MONITORING;
        liveFrameCount = 0;
        statusDisplay.textContent = 'Position your face in the oval';
        statusDisplay.className = 'status';
        processedImageContainer.innerHTML = '';
        
        // Start session timer
        startSession();
        startAuthentication();
    } catch (err) {
        debug.error('Camera error:', err);
        let errorMessage = err.message;
        if (!isSecure && !isLocalhost) {
            errorMessage = 'Camera access requires HTTPS or localhost';
        } else if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
            errorMessage = 'Your camera does not support the required settings. Please try another device.';
        }
        statusDisplay.textContent = `Camera error: ${errorMessage}`;
        statusDisplay.className = 'status error';
    }
}

// Start camera when page loads
document.addEventListener('DOMContentLoaded', initializeCamera);

// Flutter communication
function notifyFlutter(message) {
    if (window.flutter_inappwebview) {
        // For Flutter InAppWebView
        window.flutter_inappwebview.callHandler('authenticationComplete', message);
    } else if (window.webkit && window.webkit.messageHandlers) {
        // For iOS WKWebView
        window.webkit.messageHandlers.authenticationComplete.postMessage(message);
    } else if (window.AndroidInterface) {
        // For Android WebView
        window.AndroidInterface.authenticationComplete(JSON.stringify(message));
    }
    debug.log('Notified Flutter:', message);
}

// Face position feedback
function updateFacePosition(result) {
    const ovalBorder = document.querySelector('.oval-border');
    const currentTime = Date.now();
    
    function resetUI() {
        // Only reset if enough time has passed since last status change
        if (currentTime - lastStatusUpdate >= STATUS_DEBOUNCE_TIME) {
            liveFrameCount = 0;
            ovalBorder.classList.remove('analyzing');
            ovalBorder.classList.remove('success');
            ovalBorder.classList.remove('no-face');
            statusDisplay.className = 'status';
            statusHint.textContent = '';
            Array.from(progressDots).forEach(dot => dot.classList.remove('active'));
            lastStatusUpdate = currentTime;
            debug.log('UI reset - Face not live');
        }
    }

    function updateProgress() {
        const progress = Math.min(liveFrameCount, 4);
        Array.from(progressDots).forEach((dot, index) => {
            dot.classList.toggle('active', index < progress);
        });
        debug.log(`Progress: ${progress}/4 frames, Live count: ${liveFrameCount}`);
    }

    // Log the incoming result with more detail
    debug.log('Server response details', {
        is_live: result.is_live,
        message: result.message,
        confidence: result.confidence,
        liveness_message: result.liveness_message,
        recognized_name: result.recognized_name,
        depth_mm: result.depth_mm
    });

    // Handle error cases
    if (!result || result.error) {
        debug.log('Invalid result or error from server');
        return;  // Don't reset UI, just ignore this frame
    }

    // Update status message with debouncing
    if (!result.is_live || result.liveness_message === "Keep only one face in the oval") {
        if (currentTime - lastStatusUpdate >= STATUS_DEBOUNCE_TIME) {
            resetUI();
            ovalBorder.classList.add('no-face');
            statusDisplay.classList.add('error');
            statusDisplay.textContent = result.liveness_message || result.message;
            
            // Add specific hint for multiple faces
            if (result.liveness_message === "Keep only one face in the oval") {
                statusHint.textContent = 'Only one person should be in frame';
            }
            lastStatusUpdate = currentTime;
        }
    } else {
        if (currentTime - lastStatusUpdate >= STATUS_DEBOUNCE_TIME/2) { // Use shorter debounce for positive states
            debug.log('Face is live, frame count:', liveFrameCount);
            ovalBorder.classList.add('analyzing');
            ovalBorder.classList.remove('no-face');
            statusDisplay.classList.add('analyzing');
            statusDisplay.textContent = result.liveness_message || result.message;
            lastStatusUpdate = currentTime;
            
            // Only increment if we're not already authenticated
            if (currentState !== AUTH_STATE.AUTHENTICATED) {
                liveFrameCount++;
                updateProgress();

                if (liveFrameCount >= REQUIRED_LIVE_FRAMES) {
                    debug.log('Sufficient live frames detected');
                    currentState = AUTH_STATE.AUTHENTICATED;
                    ovalBorder.classList.remove('analyzing');
                    ovalBorder.classList.add('success');
                    statusDisplay.textContent = 'Welcome!';
                    statusDisplay.className = 'status success';
                    statusHint.textContent = 'Face verified successfully';
                    Array.from(progressDots).forEach(dot => dot.classList.add('active'));
                    
                    // Notify Flutter about successful authentication
                    notifyFlutter({
                        status: 'success',
                        message: 'Authentication successful',
                        timestamp: Date.now()
                    });
                    
                    // Stop the authentication loop
                    if (authenticationLoop) {
                        clearTimeout(authenticationLoop);
                        authenticationLoop = null;
                    }
                } else {
                    statusDisplay.textContent = 'Face Detected';
                    statusDisplay.className = 'status analyzing';
                    statusHint.textContent = 'Verifying...';
                }
            }
        }
    }

    // Update processed image if available
    if (result.processed_image) {
        processedImageContainer.innerHTML = `<img src="data:image/jpeg;base64,${result.processed_image}" alt="Processed face">`;
        debug.log('Updated processed image');
    }
}

// Reset UI state
function resetUI() {
    const ovalBorder = document.querySelector('.oval-border');
    if (ovalBorder) {
        ovalBorder.classList.remove('analyzing');
        ovalBorder.classList.remove('success');
        ovalBorder.classList.remove('no-face');
    }
    
    const statusDisplay = document.getElementById('status');
    if (statusDisplay) {
        statusDisplay.className = 'status';
        statusDisplay.textContent = '';
    }
    
    const statusHint = document.getElementById('statusHint');
    if (statusHint) {
        statusHint.textContent = '';
    }
    
    const progressDots = document.getElementById('progressDots');
    if (progressDots) {
        Array.from(progressDots.children).forEach(dot => dot.classList.remove('active'));
    }
    
    debug.log('UI reset');
}

// Capture frame from video
async function captureFrame() {
    if (!video.videoWidth || !video.videoHeight) {
        throw new Error('Video dimensions not available');
    }
    
    // Get oval guide dimensions and position
    const ovalGuide = document.querySelector('.oval-guide');
    const videoRect = video.getBoundingClientRect();
    const ovalRect = ovalGuide.getBoundingClientRect();
    
    // Calculate video aspect ratio and container aspect ratio
    const videoAspect = video.videoWidth / video.videoHeight;
    const containerAspect = videoRect.width / videoRect.height;
    
    // Calculate scale factors between display size and actual video dimensions
    const scale = Math.min(
        video.videoWidth / videoRect.width,
        video.videoHeight / videoRect.height
    );
    
    // Calculate video offset within its container
    let xOffset = 0;
    let yOffset = 0;
    
    if (containerAspect > videoAspect) {
        // Video is letterboxed (black bars on sides)
        const actualWidth = videoRect.height * videoAspect;
        xOffset = (videoRect.width - actualWidth) / 2;
    } else {
        // Video is pillarboxed (black bars on top/bottom)
        const actualHeight = videoRect.width / videoAspect;
        yOffset = (videoRect.height - actualHeight) / 2;
    }
    
    // Calculate dynamic oval size based on video dimensions
    let targetOvalWidth, targetOvalHeight;
    
    if (videoAspect >= 1) {
        // Landscape or square video
        targetOvalHeight = video.videoHeight * 0.75; // Decreased from 0.85 to 0.75
        targetOvalWidth = targetOvalHeight * 0.75; // 3:4 aspect ratio
    } else {
        // Portrait video
        targetOvalWidth = video.videoWidth * 0.75; // Decreased from 0.85 to 0.75
        targetOvalHeight = targetOvalWidth * 1.33; // 3:4 aspect ratio
    }
    
    // Ensure oval doesn't exceed video boundaries but allow it to be larger
    targetOvalWidth = Math.min(targetOvalWidth, video.videoWidth * 0.85);  // Decreased from 0.95 to 0.85
    targetOvalHeight = Math.min(targetOvalHeight, video.videoHeight * 0.85);  // Decreased from 0.95 to 0.85
    
    // Calculate oval position relative to video content
    const ovalData = {
        x: Math.max(0, Math.round((ovalRect.left - videoRect.left - xOffset) * scale)),
        y: Math.max(0, Math.round((ovalRect.top - videoRect.top - yOffset) * scale)),
        width: Math.round(targetOvalWidth),
        height: Math.round(targetOvalHeight)
    };
    
    debug.log('Video and oval dimensions', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        videoAspect: videoAspect.toFixed(3),
        containerAspect: containerAspect.toFixed(3),
        scale: scale.toFixed(3),
        ovalWidth: ovalData.width,
        ovalHeight: ovalData.height,
        ovalX: ovalData.x,
        ovalY: ovalData.y
    });
    
    // Use the actual video dimensions
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    try {
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        
        if (!dataUrl || !dataUrl.startsWith('data:image/jpeg')) {
            throw new Error('Invalid frame capture');
        }
        
        const frameData = {
            image: dataUrl,
            ovalGuide: ovalData
        };
        
        return frameData;
    } catch (err) {
        debug.error('Frame capture error:', err);
        return null;
    }
}

// Main authentication loop
async function startAuthentication() {
    if (!isRunning) return;

    try {
        // Check if video is ready
        if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) {
            debug.log('Video not ready yet, retrying...');
            authenticationLoop = setTimeout(startAuthentication, FRAME_INTERVAL);
            return;
        }

        // Don't continue checking if already authenticated
        if (currentState === AUTH_STATE.AUTHENTICATED) {
            debug.log('Already authenticated, stopping loop');
            return;
        }

        // Capture and analyze frame
        const frameData = await captureFrame();
        if (!frameData) {
            debug.log('Failed to capture frame, retrying...');
            authenticationLoop = setTimeout(startAuthentication, FRAME_INTERVAL);
            return;
        }

        debug.log('Sending frame to server...');
        const response = await fetch('/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ 
                image: frameData.image,
                ovalGuide: frameData.ovalGuide,
                timestamp: Date.now()
            })
        });
        
        if (!response.ok) {
            notifyFlutter({
                status: 'error',
                message: `Server error: ${response.status}`,
                timestamp: Date.now()
            });
            throw new Error(`Server error: ${response.status}`);
        }
        
        const result = await response.json();
        
        // Check if result indicates an error
        if (result.error) {
            debug.error('Server processing error:', result.error);
            notifyFlutter({
                status: 'error',
                message: result.error,
                timestamp: Date.now()
            });
            authenticationLoop = setTimeout(startAuthentication, FRAME_INTERVAL);
            return;
        }
        
        debug.log('Server response:', result);
        
        // Update UI based on result
        updateFacePosition(result);
        
    } catch (err) {
        debug.error('Authentication error:', err);
        notifyFlutter({
            status: 'error',
            message: err.message,
            timestamp: Date.now()
        });
        if (err.message.includes('Server error:')) {
            resetUI();
        }
    }
    
    // Schedule next check if still running and not authenticated
    if (isRunning && currentState !== AUTH_STATE.AUTHENTICATED) {
        authenticationLoop = setTimeout(startAuthentication, FRAME_INTERVAL);
    }
}

// Initialize debug panel
if (DEBUG) {
    console.log('[Debug] Debug mode enabled');
}

function updateOvalGuide() {
    const video = document.getElementById('videoElement');
    const overlay = document.getElementById('overlay');
    
    // Get video dimensions
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const aspectRatio = videoWidth / videoHeight;
    
    // Calculate optimal oval dimensions based on aspect ratio
    let targetOvalWidth, targetOvalHeight;
    
    if (aspectRatio >= 1) {  // Landscape or square video
        // Base the oval height on video height first
        targetOvalHeight = videoHeight * 0.70;  // Increased from 0.65 for better face framing
        // Calculate width to maintain face proportions (typical face aspect ratio is 0.75)
        targetOvalWidth = targetOvalHeight * 0.80;  // Increased from 0.75 for wider oval
        
        // Ensure width isn't too large
        if (targetOvalWidth > videoWidth * 0.80) {  // Increased from 0.75
            targetOvalWidth = videoWidth * 0.80;
            targetOvalHeight = targetOvalWidth / 0.75;  // Maintain face proportion
        }
    } else {  // Portrait video
        // Base the oval width on video width first
        targetOvalWidth = videoWidth * 0.70;  // Increased from 0.65
        // Calculate height to maintain face proportions (typical face aspect ratio is 1.33)
        targetOvalHeight = targetOvalWidth * 1.40;  // Increased from 1.33 for taller oval
        
        // Ensure height isn't too large
        if (targetOvalHeight > videoHeight * 0.80) {  // Increased from 0.75
            targetOvalHeight = videoHeight * 0.80;
            targetOvalWidth = targetOvalHeight * 0.75;
        }
    }
    
    // Apply maximum bounds relative to frame size
    targetOvalWidth = Math.min(targetOvalWidth, videoWidth * 0.80);   // Increased from 0.75
    targetOvalHeight = Math.min(targetOvalHeight, videoHeight * 0.80); // Increased from 0.75
    
    // Calculate position to center the oval
    const left = (videoWidth - targetOvalWidth) / 2;
    const top = (videoHeight - targetOvalHeight) / 2;
    
    // Update overlay dimensions and position
    overlay.style.width = `${videoWidth}px`;
    overlay.style.height = `${videoHeight}px`;
    
    // Store oval dimensions for face detection
    window.ovalGuide = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(targetOvalWidth),
        height: Math.round(targetOvalHeight)
    };
    
    // Update CSS custom properties for the oval
    document.documentElement.style.setProperty('--oval-width', `${Math.round(targetOvalWidth)}px`);
    document.documentElement.style.setProperty('--oval-height', `${Math.round(targetOvalHeight)}px`);
    document.documentElement.style.setProperty('--oval-top', `${Math.round(top)}px`);
    document.documentElement.style.setProperty('--oval-left', `${Math.round(left)}px`);
    
    // Log oval dimensions for debugging
    console.log('Video dimensions:', videoWidth, 'x', videoHeight, 'Aspect ratio:', aspectRatio);
    console.log('Oval dimensions:', targetOvalWidth, 'x', targetOvalHeight);
    console.log('Oval position:', left, ',', top);
}

// Update oval guide when video dimensions change
video.addEventListener('loadedmetadata', updateOvalGuide);
window.addEventListener('resize', updateOvalGuide);

// Ensure oval is updated periodically during video
setInterval(updateOvalGuide, 1000);  // Check every second for any changes