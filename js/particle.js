(function init3DParticles() {
    // ==========================================================
    // 1. 创建独立的 3D 画布并挂载
    // ==========================================================
    const threeCanvas = document.createElement('canvas');
    threeCanvas.id = 'three-particle-canvas';
    threeCanvas.style.position = 'absolute';
    threeCanvas.style.top = '0';
    threeCanvas.style.left = '0';
    threeCanvas.style.width = '100%';
    threeCanvas.style.height = '100%';
    threeCanvas.style.zIndex = '4000'; // 悬浮在最顶层，穿透所有背景和弹窗
    threeCanvas.style.pointerEvents = 'none'; // 保证鼠标能穿透它去点击地图
    
    const mainContent = document.getElementById('main-content');
    if(mainContent) {
        mainContent.insertBefore(threeCanvas, mainContent.firstChild);
    }

    // ==========================================================
    // 2. 场景、相机与渲染器
    // ==========================================================
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x1e0505, 0.0015); 

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 250;

    const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true ,preserveDrawingBuffer: true});
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ==========================================================
    // 3. 粒子材质 (生成柔和的圆形星火贴图)
    // ==========================================================
    function createGlowingTexture() {
        const texCanvas = document.createElement('canvas');
        texCanvas.width = 32;
        texCanvas.height = 32;
        const context = texCanvas.getContext('2d');
        const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.2, 'rgba(255, 50, 50, 0.8)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 32, 32);
        return new THREE.CanvasTexture(texCanvas);
    }

    // ==========================================================
    // 4. 初始化粒子坐标阵列（根据电脑性能动态调整）
    // ==========================================================
    let particleCount = 15000;
    if (typeof navigator !== 'undefined') {
        const cpuCores = navigator.hardwareConcurrency || 4;
        const deviceMemory = navigator.deviceMemory || 4;
        if (cpuCores >= 8 && deviceMemory >= 8) {
            particleCount = 30000;
        } else if (cpuCores >= 4 && deviceMemory >= 4) {
            particleCount = 20000;
        } else if (cpuCores >= 2 && deviceMemory >= 2) {
            particleCount = 10000;
        } else {
            particleCount = 5000;
        }
    }
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const basePositions = new Float32Array(particleCount * 3);
    const originalPositions = new Float32Array(particleCount * 3); 

    for (let i = 0; i < particleCount; i++) {
        let x = (Math.random() - 0.5) * 1000;
        let y = (Math.random() - 0.5) * 800;
        let z = (Math.random() - 0.5) * 600;
        
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        
        basePositions[i * 3] = x;
        basePositions[i * 3 + 1] = y;
        basePositions[i * 3 + 2] = z;

        originalPositions[i * 3] = x;
        originalPositions[i * 3 + 1] = y;
        originalPositions[i * 3 + 2] = z;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('basePosition', new THREE.BufferAttribute(basePositions, 3));

    const material = new THREE.PointsMaterial({
        size: 1.5,
        color: 0xFFFFFF,
        map: createGlowingTexture(),
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending, 
        depthWrite: false
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    // ==========================================================
    // 5. 核心接口：提取文字像素并聚拢粒子
    // ==========================================================
    let scatterTimeout = null;
    window.triggerParticleText = function(text) {
        clearTimeout(scatterTimeout);

        material.color.setHex(0xFF0000);

        const textCanvas = document.createElement('canvas');
        const ctx = textCanvas.getContext('2d');
        textCanvas.width = window.innerWidth;
        textCanvas.height = window.innerHeight;

        let fontSize = window.innerWidth > 768 ? 150 : 80;
        ctx.fillStyle = "white";
        ctx.font = `${fontSize}px 'MaoFont', 'STXingkai', 'KaiTi', serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, textCanvas.width / 2, textCanvas.height * 0.28);

        const imgData = ctx.getImageData(0, 0, textCanvas.width, textCanvas.height).data;
        const textPixels = [];
        const step = 2; 

        for (let y = 0; y < textCanvas.height; y += step) {
            for (let x = 0; x < textCanvas.width; x += step) {
                const alpha = imgData[(y * textCanvas.width + x) * 4 + 3];
                if (alpha > 128) {
                    let pX = (x / textCanvas.width - 0.5) * 450 * (window.innerWidth / window.innerHeight);
                    let pY = -(y / textCanvas.height - 0.5) * 450;
                    textPixels.push({x: pX, y: pY});
                }
            }
        }

        const baseAttribute = geometry.attributes.basePosition;
        if (textPixels.length > 0) {
            for (let i = 0; i < particleCount; i++) {
                const pixel = textPixels[i % textPixels.length];
                
                baseAttribute.array[i * 3] = pixel.x;
                baseAttribute.array[i * 3 + 1] = pixel.y;
                baseAttribute.array[i * 3 + 2] = 0; 
            }
        }
        baseAttribute.needsUpdate = true;

        scatterTimeout = setTimeout(() => {
            material.color.setHex(0xFFFFFF);
            for (let i = 0; i < particleCount; i++) {
                baseAttribute.array[i * 3] = originalPositions[i * 3];
                baseAttribute.array[i * 3 + 1] = originalPositions[i * 3 + 1];
                baseAttribute.array[i * 3 + 2] = originalPositions[i * 3 + 2];
            }
            baseAttribute.needsUpdate = true;
        }, 4500); 
    };

    // ==========================================================
    // 6. 核心接口：四字词库自动轮播系统
    // ==========================================================
    let idiomTimer = null;
    window.startParticleIdiomShow = function(wordsArray) {
        if(idiomTimer) return;
        
        function showNext() {
            if (!wordsArray || wordsArray.length === 0) return;
            const randomWord = wordsArray[Math.floor(Math.random() * wordsArray.length)];
            window.triggerParticleText(randomWord); 
            idiomTimer = setTimeout(showNext, 8000); 
        }
        showNext();
    };

    window.stopParticleIdiomShow = function() {
        if(idiomTimer) {
            clearTimeout(idiomTimer);
            idiomTimer = null;
        }
    };

    // ==========================================================
    // 7. 鼠标排斥交互与弹性物理循环
    // ==========================================================
    const mouse = new THREE.Vector2();
    const targetMouse = new THREE.Vector3(0, 0, 0);
    let mouseMoved = false;

    window.addEventListener('mousemove', (event) => {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        mouseMoved = true;
    });

    const clock = new THREE.Clock();
    function animate() {
        requestAnimationFrame(animate);
        const time = clock.getElapsedTime();

        const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
        vector.unproject(camera);
        const dir = vector.sub(camera.position).normalize();
        const distance = -camera.position.z / dir.z;
        const pos = camera.position.clone().add(dir.multiplyScalar(distance));
        targetMouse.copy(pos);

        const positionAttribute = geometry.attributes.position;
        const baseAttribute = geometry.attributes.basePosition;

        for (let i = 0; i < particleCount; i++) {
            let ix = i * 3;
            let iy = i * 3 + 1;
            let iz = i * 3 + 2;

            let px = positionAttribute.array[ix];
            let py = positionAttribute.array[iy];
            let pz = positionAttribute.array[iz];

            let bx = baseAttribute.array[ix];
            let by = baseAttribute.array[iy];
            let bz = baseAttribute.array[iz];

            if (mouseMoved) {
                let dx = targetMouse.x - px;
                let dy = targetMouse.y - py;
                let dist = Math.sqrt(dx * dx + dy * dy);
                const interactionRadius = 50;
                if (dist < interactionRadius) {
                    let force = (interactionRadius - dist) / interactionRadius;
                    px -= (dx / dist) * force * 3; 
                    py -= (dy / dist) * force * 3;
                }
            }

            // 物理回弹系统：0.15 的高收敛力度，保证瞬间吸附
            px += (bx - px) * 0.15 + Math.sin(time + ix) * 0.1;
            py += (by - py) * 0.15 + Math.cos(time + iy) * 0.1;
            pz += (bz - pz) * 0.15;

            positionAttribute.array[ix] = px;
            positionAttribute.array[iy] = py;
            positionAttribute.array[iz] = pz;
        }

        positionAttribute.needsUpdate = true;
        renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
})();