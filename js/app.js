// ===================================================================
        // 核心架构：状态管理与渲染
        // ===================================================================

        let currentListData = allData;
        let tourTimer = null;
        let currentTabFilter = 'all';
        let globalTourIndex = currentListData.length - 1;

        // ===================================================================
        // 学习进度与收藏管理器 (localStorage 持久化)
        // ===================================================================
        const ProgressManager = {
            READ_KEY: 'mao_poems_read',
            FAV_KEY: 'mao_poems_fav',
            LAST_KEY: 'mao_poems_last',

            _getSet(key) {
                try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
                catch(e) { return new Set(); }
            },
            _saveSet(key, set) {
                try { localStorage.setItem(key, JSON.stringify([...set])); } catch(e) {}
            },
            getReadSet() { return this._getSet(this.READ_KEY); },
            markRead(id) {
                const set = this.getReadSet();
                set.add(id);
                this._saveSet(this.READ_KEY, set);
            },
            isRead(id) { return this.getReadSet().has(id); },
            getReadCount() { return this.getReadSet().size; },
            getFavSet() { return this._getSet(this.FAV_KEY); },
            toggleFav(id) {
                const set = this.getFavSet();
                if (set.has(id)) set.delete(id);
                else set.add(id);
                this._saveSet(this.FAV_KEY, set);
                return set.has(id);
            },
            isFav(id) { return this.getFavSet().has(id); },
            getLastId() { return localStorage.getItem(this.LAST_KEY) || null; },
            setLastId(id) {
                try { localStorage.setItem(this.LAST_KEY, id); } catch(e) {}
            }
        };

        // 朗读跟读高亮：当前弹窗内的诗句时间轴数据
        let currentLineTimings = [];
        let currentModalItemId = null;
        let lastHighlightLineIdx = -1;

        // ===================================================================
        // 音频预分析：fetch + decodeAudioData 离线扫描停顿点，不干扰正常播放
        // ===================================================================
        let useAnalyzedTimings = false;

        async function analyzeAudioForSilence(audioUrl, fullText) {
            try {
                const response = await fetch(audioUrl);
                if (!response.ok) return null;
                const arrayBuffer = await response.arrayBuffer();
                const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
                const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
                tmpCtx.close();

                const channelData = audioBuffer.getChannelData(0);
                const sampleRate = audioBuffer.sampleRate;
                const windowSec = 0.05; // 50ms 窗口
                const windowSize = Math.floor(sampleRate * windowSec);

                // 计算每个窗口的平均音量
                const volumes = [];
                for (let i = 0; i < channelData.length; i += windowSize) {
                    let sum = 0;
                    const end = Math.min(i + windowSize, channelData.length);
                    for (let j = i; j < end; j++) sum += Math.abs(channelData[j]);
                    volumes.push(sum / (end - i));
                }

                // 动态阈值：取最大音量的 8%
                const maxVol = Math.max(...volumes);
                const threshold = maxVol * 0.08;

                // 扫描停顿点
                const allLines = fullText.split('\n').filter(l => l.trim().length > 0);
                const transitionTimes = [0]; // 第一行从 0 开始

                let isSpeaking = false;
                let speakStart = 0;
                let silenceStart = 0;
                const MIN_SPEAK = 0.3;  // 最短说话 0.3s
                const MIN_SILENCE = 0.2; // 静音持续 0.2s 才算停顿

                for (let i = 0; i < volumes.length; i++) {
                    const time = i * windowSec;
                    if (volumes[i] > threshold) {
                        if (!isSpeaking) { isSpeaking = true; speakStart = time; }
                        silenceStart = 0;
                    } else if (isSpeaking) {
                        if (silenceStart === 0) silenceStart = time;
                        if (time - silenceStart >= MIN_SILENCE && time - speakStart >= MIN_SPEAK) {
                            isSpeaking = false;
                            if (transitionTimes.length < allLines.length) {
                                transitionTimes.push(time);
                            }
                        }
                    }
                }

                // 如果检测到的停顿点数 > 诗句行数，前端的额外停顿是标题/引言/年份
                // 例如朗读"沁园春·长沙 一九二五年"后停顿，才开始正文
                if (transitionTimes.length > allLines.length) {
                    const skipCount = transitionTimes.length - allLines.length;
                    console.log("检测到标题/引言段，跳过前", skipCount, "个停顿点");
                    transitionTimes.splice(0, skipCount);
                }

                // 转换为 currentLineTimings 格式
                const allLineCount = fullText.split('\n').length;
                const timings = [];
                let nonEmptyIdx = 0;
                for (let i = 0; i < allLineCount; i++) {
                    const lineText = fullText.split('\n')[i];
                    if (lineText.trim().length === 0) continue;
                    const tIdx = Math.min(nonEmptyIdx, transitionTimes.length - 1);
                    const start = transitionTimes[tIdx];
                    const end = nonEmptyIdx < transitionTimes.length - 1
                        ? transitionTimes[nonEmptyIdx + 1]
                        : audioBuffer.duration;
                    timings.push({ start, end, lineIndex: i });
                    nonEmptyIdx++;
                }

                console.log("音频预分析完成，检测到", transitionTimes.length, "个停顿点");
                return timings;
            } catch(e) {
                console.warn("音频预分析失败，将使用时间估算", e);
                return null;
            }
        }

        // 朗读跟读：根据音频时长按字符+标点权重分配每句高亮时间段
        function setupLineTimings(fullText, duration) {
            if (!duration || isNaN(duration) || duration <= 0) { currentLineTimings = []; return; }
            const allLines = fullText.split('\n');
            const nonEmpty = allLines.map((text, i) => ({ text, i })).filter(l => l.text.trim().length > 0);
            if (nonEmpty.length === 0) { currentLineTimings = []; return; }

            // 首部留 2s 补偿（部分音频会先朗读标题/年份再开始正文），尾部留 0.5s
            const startBuffer = 2.0;
            const endBuffer = Math.min(0.5, duration * 0.05);
            const effectiveDuration = duration - startBuffer - endBuffer;

            // 权重 = 字符数 + 标点附加（句号/问号/感叹号加权更多）
            const weights = nonEmpty.map(l => {
                let w = l.text.replace(/[\s]/g, '').length; // 纯字符数
                // 句末标点增加权重（朗读者会在句末停顿更久）
                if (/[。！？]/.test(l.text)) w += 3;
                else if (/[，、；：]/.test(l.text)) w += 1.5;
                return w;
            });
            const totalWeight = weights.reduce((s, w) => s + w, 0);

            // 句间停顿：句末有句号停 0.4s，逗号停 0.25s，其他 0.15s
            const pauses = nonEmpty.map(l => {
                if (/[。！？]/.test(l.text)) return 0.4;
                if (/[，、；：]/.test(l.text)) return 0.25;
                return 0.15;
            });
            const totalPause = pauses.reduce((s, p) => s + p, 0);
            const readTime = Math.max(effectiveDuration - totalPause, effectiveDuration * 0.8);

            let t = startBuffer;
            currentLineTimings = nonEmpty.map((l, idx) => {
                const dur = (weights[idx] / totalWeight) * readTime;
                const seg = { start: t, end: t + dur, lineIndex: l.i };
                t += dur + pauses[idx];
                return seg;
            });
            // 最后一句延伸到音频末尾
            if (currentLineTimings.length > 0) currentLineTimings[currentLineTimings.length - 1].end = duration;
        }

        // 更新学习进度条显示
        function updateProgressDisplay() {
            const readCount = ProgressManager.getReadCount();
            const totalCount = allData.length;
            const pct = totalCount > 0 ? (readCount / totalCount) * 100 : 0;
            const rc = document.getElementById('read-count');
            const tc = document.getElementById('total-count');
            const pf = document.getElementById('progress-fill');
            if (rc) rc.innerText = readCount;
            if (tc) tc.innerText = totalCount;
            if (pf) pf.style.width = pct + '%';
        }

        // 更新单张卡片的已读/收藏徽章
        function updateCardBadges(itemId) {
            const card = document.getElementById(itemId);
            if (!card) return;
            card.classList.toggle('is-read', ProgressManager.isRead(itemId));
            card.classList.toggle('is-fav', ProgressManager.isFav(itemId));
        }

        function getLinesForData(dataArray) {
            let lines = [];
            let imp = dataArray.filter(d => d.isImportant);
            for(let i = 0; i < imp.length - 1; i++) {
                lines.push({
                    coords: [imp[i].value, imp[i+1].value],
                    lineStyle: { color: imp[i+1].itemStyle.color } 
                });
            }
            return lines;
        }

        // 全局核心统一状态控制器：同步地图生长、Timeline滑块、以及右侧列表
        function setTimeState(index, updateFocus = true) {
            if (index < 0 || index >= currentListData.length) return;
            globalTourIndex = index;
            let currentItem = currentListData[index];

            // 保存最后浏览位置（用于下次打开时恢复）
            if (currentItem && currentItem._uniqueId) {
                ProgressManager.setLastId(currentItem._uniqueId);
            }

            if (currentItem && currentItem.quote) {
                fireDanmaku(currentItem.quote);
            }

            const slider = document.getElementById('time-slider');
            slider.value = index;

            // 核心计算逻辑
            const percentRaw = slider.max > 0 ? (index / slider.max) : 1;
            const percent = percentRaw * 100;
            slider.style.background = `linear-gradient(to right, #ba2a24 0%, #ba2a24 ${percent}%, rgba(255,255,255,0.1) ${percent}%, rgba(255,255,255,0.1) 100%)`;

            // =========================================================
            // 年份悬浮窗精准跟随逻辑
            // =========================================================
            const yearLabel = document.getElementById('timeline-current-year');
            if (yearLabel) {
                yearLabel.innerText = currentItem.year + ' 年';
                
                const sliderLeft = slider.offsetLeft;
                const sliderWidth = slider.clientWidth;
                
                // 确保哪怕元素在初始化时还没渲染出来，也不会计算报错
                if (sliderWidth > 0) {
                    const exactPosition = sliderLeft + 7 + percentRaw * (sliderWidth - 14);
                    yearLabel.style.left = exactPosition + 'px';
                }
            }

            let historyData = currentListData.slice(0, index + 1);
            let historyImportant = historyData.filter(d => d.isImportant);
            let historyLines = getLinesForData(historyData); 

            if(myChart) {
                myChart.setOption({
                    series: [
                        {}, {}, {}, 
                        { data: historyImportant }, 
                        { data: updateFocus && currentItem.isImportant ? [currentItem] : [] }, 
                        { data: historyLines } 
                    ]
                });

                if (updateFocus && currentItem.isImportant) {
                    setTimeout(() => {
                        let mapData = myChart.getOption().series[3].data;
                        let dataIndex = mapData.findIndex(d => d._uniqueId === currentItem._uniqueId);
                        if(dataIndex !== -1) myChart.dispatchAction({ type: 'showTip', seriesIndex: 3, dataIndex: dataIndex });
                    }, 100);
                } else {
                    myChart.dispatchAction({ type: 'hideTip' });
                }
            }

            document.querySelectorAll('.school-card').forEach(el => el.classList.remove('active'));
            let activeCard = document.getElementById(currentItem._uniqueId);
            if(activeCard) {
                activeCard.classList.add('active');
                if (updateFocus) {
                    // 移动端底部横向列表：水平居中滚动；桌面端：垂直居中滚动
                    if (window.innerWidth <= 768) {
                        activeCard.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                    } else {
                        activeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            }
        }
        function initTimeline() {
            const slider = document.getElementById('time-slider');
            slider.max = currentListData.length - 1;
            
            if (currentListData.length > 0) {
                document.getElementById('timeline-start-year').innerText = currentListData[0].year;
                document.getElementById('timeline-end-year').innerText = currentListData[currentListData.length - 1].year;
            }
            
            slider.oninput = function() {
                if(tourTimer) stopTour();
                setTimeState(parseInt(this.value), true); 
            };
        }

        // 核心进入地图的逻辑被单独抽离出来，供视频结束或跳过时调用
        function enterMainMap() {
            const videoContainer = document.getElementById('intro-video-container');
            if (videoContainer) videoContainer.style.display = 'none'; // 隐藏视频层
            
            const main = document.getElementById('main-content');
            main.classList.add('active');
            
            if(!isPlaying) document.getElementById('music-btn').click(); // 开启主背景音乐
            
            initSidebar(); 
            fireConfetti(); 
            window.renderChinaMap(); 
        }

        // 修改后的启动系统：加入视频转场
        // function startSystem() {
        //     const entry = document.getElementById('entry-screen');
        //     const videoContainer = document.getElementById('intro-video-container');
        //     const introVideo = document.getElementById('intro-video');
        //     const skipBtn = document.getElementById('skip-video-btn');
            
        //     // 1. 入场屏渐隐消失
        //     entry.style.opacity = '0';
            
        //     setTimeout(() => {
        //         entry.style.display = 'none'; 
                
        //         // 2. 如果存在视频，则展示并播放
        //         if (videoContainer && introVideo) {
        //             videoContainer.style.display = 'block';
                    
        //             introVideo.play().catch(e => {
        //                 console.warn('浏览器拦截了自动播放，直接进入主界面', e);
        //                 enterMainMap(); 
        //             });
                    
        //             // 3. 视频自然播放结束时，进入主地图
        //             introVideo.onended = () => {
        //                 enterMainMap();
        //             };
                    
        //             // 4. 用户点击跳过按钮时，停止视频并进入主地图
        //             skipBtn.onclick = () => {
        //                 introVideo.pause();
        //                 enterMainMap();
        //             };
                    
        //             // 视频播放期间如果有右侧 hover 效果，加个简单的高亮交互
        //             skipBtn.onmouseover = () => { skipBtn.style.color = '#FFD700'; skipBtn.style.borderColor = '#FFD700'; };
        //             skipBtn.onmouseout = () => { skipBtn.style.color = '#d4a373'; skipBtn.style.borderColor = 'rgba(212,163,115,0.4)'; };

        //         } else {
        //             // 如果没配置视频源，直接进入主地图
        //             enterMainMap(); 
        //         }
        //     }, 1500); // 配合入场屏的淡出动画时间
        // }
        async function startSystem() {
            const entry = document.getElementById('entry-screen');
            const videoContainer = document.getElementById('intro-video-container');
            const introVideo = document.getElementById('intro-video');
            const bgm = document.getElementById('bgm');
            const waveOverlay = document.getElementById('intro-wave-overlay');

            // === 移动端快速通道：跳过视频转场，直接进入主地图 ===
            if (window.innerWidth <= 768) {
                entry.style.display = 'none';
                if (videoContainer) videoContainer.style.display = 'none';
                document.body.classList.add('mobile-mode');
                const mainEl = document.getElementById('main-content');
                mainEl.classList.add('active');
                if (bgm) { bgm.src = 'audio/mainaudio.mp3'; bgm.volume = 0.4; bgm.play().catch(()=>{}); isPlaying = true; document.getElementById('music-btn').classList.add('playing'); }
                initSidebar();
                window.renderChinaMap();
                return; // 移动端到此结束，不走下面的视频逻辑
            }

            // 1. 入场屏渐隐
            entry.style.opacity = '0';

            await new Promise(resolve => setTimeout(resolve, 600)); // 等待淡出动画前半段

            // 触发金色光波从中心扩散（与按钮位置呼应）
            if (waveOverlay) {
                waveOverlay.classList.remove('active');
                // 强制重排以重启动画
                void waveOverlay.offsetWidth;
                waveOverlay.classList.add('active');
            }

            await new Promise(resolve => setTimeout(resolve, 800)); // 等待光波扩散
            entry.style.display = 'none';
            
            // 2. 判断是否有转场视频
            if (videoContainer && introVideo) {
                videoContainer.style.display = 'block';
                introVideo.muted = false; // 确保视频声音开启
                
                // 播放视频并等待其结束
                try {
                    await introVideo.play();
                } catch (e) {
                    console.warn("视频自动播放被拦截，直接进入主界面", e);
                }

                // 监听结束或手动跳过
                await new Promise(resolve => {
                    introVideo.onended = resolve;
                    document.getElementById('skip-video-btn').onclick = () => {
                        introVideo.pause();
                        resolve();
                    };
                });

                // 视频结束后，隐藏视频容器
                videoContainer.style.display = 'none';
            }

            // 3. 视频结束后，才正式启动主地图逻辑与BGM
            const main = document.getElementById('main-content');
            main.classList.add('active');

            // 动态设置背景音乐 src（不在 HTML 源码暴露音频路径）
            if (bgm) bgm.src = 'audio/mainaudio.mp3';

            // 开启主背景音乐
            if (bgm) {
                bgm.volume = 0; // 从静音开始
                bgm.play().then(() => {
                    isPlaying = true;
                    document.getElementById('music-btn').classList.add('playing');
                    // 平滑音量渐入
                    let fade = setInterval(() => {
                        if (bgm.volume < 0.5) bgm.volume += 0.05;
                        else clearInterval(fade);
                    }, 100);
                }).catch(e => console.warn("背景音乐播放拦截", e));
            }

            initSidebar();
            fireConfetti();
            window.renderChinaMap();

            // 恢复上次浏览位置
            setTimeout(() => {
                const lastId = ProgressManager.getLastId();
                if (lastId) {
                    const idx = currentListData.findIndex(d => d._uniqueId === lastId);
                    if (idx !== -1) setTimeState(idx, false);
                }
            }, 1200);
        }

        function fireConfetti(e) {
            if (typeof confetti === 'undefined') return;
            const duration = 3 * 1000; const end = Date.now() + duration;
            (function frame() {
                confetti({ particleCount: 8, angle: 60, spread: 80, origin: { x: 0, y: 0.8 }, colors: ['#FFD700', '#ba2a24', '#ffffff'] });
                confetti({ particleCount: 8, angle: 120, spread: 80, origin: { x: 1, y: 0.8 }, colors: ['#FFD700', '#ba2a24', '#ffffff'] });
                if (Date.now() < end) requestAnimationFrame(frame);
            }());
        }

        const eCanvas = document.getElementById('entry-star-canvas'); const eCtx = eCanvas.getContext('2d');
        eCanvas.width = window.innerWidth; eCanvas.height = window.innerHeight;
        let eStars = Array.from({length: 100}, () => ({ x: Math.random() * eCanvas.width, y: Math.random() * eCanvas.height, s: Math.random()*1.5, a: Math.random() }));
        function drawEStars() {
            eCtx.clearRect(0,0,eCanvas.width, eCanvas.height);
            eStars.forEach(st => { eCtx.beginPath(); eCtx.arc(st.x, st.y, st.s, 0, Math.PI*2); eCtx.fillStyle = `rgba(255, 215, 0, ${st.a})`; eCtx.fill(); st.y -= st.s; if(st.y<0) st.y = eCanvas.height; });
            requestAnimationFrame(drawEStars);
        }
        drawEStars();

        const starCanvas = document.getElementById('star-canvas'); const ctx = starCanvas.getContext('2d'); let stars = [];
        const rgbColors = ['255, 215, 0', '255, 69, 0', '255, 51, 51', '255, 255, 255'];
        function initStars() {
            starCanvas.width = window.innerWidth; starCanvas.height = window.innerHeight;
            stars = Array.from({length: 180}, () => ({ 
                x: Math.random() * starCanvas.width, y: Math.random() * starCanvas.height, radius: Math.random() * 1.5, speed: Math.random() * 0.5 + 0.1, opacity: Math.random(), color: rgbColors[Math.floor(Math.random() * rgbColors.length)]
            }));
        }
        function drawStars() {
            ctx.clearRect(0, 0, starCanvas.width, starCanvas.height);
            stars.forEach(star => {
                ctx.beginPath(); ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2); ctx.fillStyle = `rgba(${star.color}, ${star.opacity})`; ctx.fill();
                star.y -= star.speed; if (star.y < 0) { star.y = starCanvas.height; star.x = Math.random() * starCanvas.width; }
            });
            requestAnimationFrame(drawStars);
        }
        initStars(); drawStars();

        // ===================================================================
        // 地图初始化与渲染
        // ===================================================================

        

        // ===================================================================
        // 交互逻辑模块
        // ===================================================================

        const bgm = document.getElementById('bgm');
        const poemAudioPlayer = document.getElementById('poem-audio');
        let isPlaying = false;

        // 👇 核心修复：为音乐按钮绑定真实的播放/暂停控制逻辑
        const musicBtn = document.getElementById('music-btn');
        if (musicBtn) {
            musicBtn.addEventListener('click', function() {
                if (!bgm) return;
                
                if (isPlaying) {
                    // 如果当前正在播放，则暂停，并移除图标的旋转/呼吸动画
                    bgm.pause();
                    isPlaying = false;
                    this.classList.remove('playing');
                } else {
                    // 如果当前处于暂停状态，则开始播放，并激活图标动画
                    bgm.play().then(() => {
                        isPlaying = true;
                        this.classList.add('playing');
                    }).catch(e => console.warn("背景音乐播放被拦截", e));
                }
            });
        }

        poemAudioPlayer.addEventListener('timeupdate', () => {
            if (poemAudioPlayer.duration) {
                const progress = (poemAudioPlayer.currentTime / poemAudioPlayer.duration) * 100;
                document.getElementById('audio-progress-bar').style.width = progress + '%';
            }
        });

        // 音频播放/暂停/结束时切换文字亮度
        poemAudioPlayer.addEventListener('play', () => {
            document.getElementById('modal-full-text').classList.add('audio-playing');
        });
        poemAudioPlayer.addEventListener('pause', () => {
            document.getElementById('modal-full-text').classList.remove('audio-playing');
        });
        poemAudioPlayer.addEventListener('ended', () => {
            document.getElementById('modal-full-text').classList.remove('audio-playing');
        });

        window.togglePoemAudio = function() {
    const audioBtn = document.getElementById('modal-audio-control');
    
    // 检查当前朗读音频是否处于暂停状态
    if (poemAudioPlayer.paused) {
        poemAudioPlayer.play();
        audioBtn.innerHTML = '🔊 暂停朗读';
        audioBtn.classList.add('playing');
        if(isPlaying) bgm.volume = 0.2;
    } else {
        poemAudioPlayer.pause();
        audioBtn.innerHTML = '🔈 播放朗读'; 
        audioBtn.classList.remove('playing');
        // 暂停朗读时，主音乐恢复
        if(isPlaying) bgm.volume = 1.0; 
    }
};

        window.toggleMapLock = function() {
            isMapLocked = !isMapLocked;
            document.getElementById('lock-btn').innerText = isMapLocked ? '🔒' : '🔓';
            document.getElementById('lock-btn').classList.toggle('locked', isMapLocked);
            if(myChart) myChart.setOption({ geo: { roam: !isMapLocked } });
        };

        window.resetMap = function() {
            if(myChart) myChart.dispatchAction({ type: 'restore' });
        };

        // 卡片背景图片配置
        // 使用方法：把图片放到 images/card-bg/ 文件夹，然后在下面数组里添加路径
        // 配置后导出卡片时会自动使用第一张图片作为背景
        const cardBgImages = [
            'images/card-bg/bg1.jpg','images/card-bg/bg2.jpg','images/card-bg/bg3.jpg','images/card-bg/bg4.jpg',
            'images/card-bg/bg5.jpg','images/card-bg/bg6.jpg','images/card-bg/bg8.jpg','images/card-bg/bg9.jpg',
            'images/card-bg/bg10.jpg','images/card-bg/bg11.jpg','images/card-bg/bg12.jpg',
            'images/card-bg/bg13.jpg','images/card-bg/bg14.jpg','images/card-bg/bg15.jpg','images/card-bg/bg16.jpg',
            'images/card-bg/bg17.jpg','images/card-bg/bg18.jpg','images/card-bg/bg19.jpg','images/card-bg/bg20.jpg',
            'images/card-bg/bg21.jpg','images/card-bg/bg22.jpg','images/card-bg/bg23.jpg','images/card-bg/bg24.jpg',
            'images/card-bg/bg25.jpg','images/card-bg/bg26.jpg','images/card-bg/bg27.jpg','images/card-bg/bg28.jpg',
            'images/card-bg/bg29.jpg','images/card-bg/bg30.jpg','images/card-bg/bg31.jpg','images/card-bg/bg32.jpg',
            'images/card-bg/bg33.jpg','images/card-bg/bg34.jpg','images/card-bg/bg35.jpg','images/card-bg/bg36.jpg',
            'images/card-bg/bg37.jpg','images/card-bg/bg38.jpg','images/card-bg/bg39.jpg','images/card-bg/bg40.jpg',
            'images/card-bg/bg41.jpg','images/card-bg/bg42.jpg','images/card-bg/bg43.jpg','images/card-bg/bg44.jpg',
            'images/card-bg/bg45.jpg','images/card-bg/bg46.jpg','images/card-bg/bg47.jpg','images/card-bg/bg48.jpg',
            'images/card-bg/bg49.jpg','images/card-bg/bg50.jpg','images/card-bg/bg51.jpg',
        ];
        let cardBgImage = cardBgImages.length > 0 ? cardBgImages[0] : null;

        
        window.openPoemModal = function(itemData) {
        if(!itemData) return;
        if (typeof itemData === 'string') itemData = allData.find(d => d._uniqueId === itemData);

        // 记录当前弹窗诗词 ID（供收藏按钮使用）
        currentModalItemId = itemData._uniqueId;

        // 标记为已读并更新进度
        ProgressManager.markRead(itemData._uniqueId);
        updateProgressDisplay();
        updateCardBadges(itemData._uniqueId);

        // =================================================================
        // 👇 就是这里！新增触发代码：通知 3D 粒子引擎去拼出这首词的名字
        // =================================================================
        if (window.triggerParticleText && itemData.poem) {
            window.triggerParticleText(itemData.poem);
        }

        const bgVideo = document.getElementById('modal-bg-video');

        console.log("准备加载的视频路径是: ", itemData.video);
        if (bgVideo && itemData.video) {
            bgVideo.src = itemData.video;
            bgVideo.style.display = 'block';
        } else if (bgVideo) {
            bgVideo.style.display = 'none';
        }

        // 设置文本内容
        const randomModalQuote = longMaoQuotes[Math.floor(Math.random() * longMaoQuotes.length)];
        document.getElementById('modal-quote-text').innerText = randomModalQuote;
        document.getElementById('modal-poem-title').innerText = itemData.poem;
        document.getElementById('modal-poem-year').innerText = itemData.year;
        document.getElementById('modal-poem-location').innerText = itemData.name;

        // 朗读跟读高亮：将全诗拆分为逐行 div，方便后续高亮
        const fullTextEl = document.getElementById('modal-full-text');
        fullTextEl.classList.remove('audio-playing');
        // 重置字号和语速
        modalFontScale = 1.0;
        fullTextEl.style.fontSize = '';
        document.getElementById('modal-background-text').style.fontSize = '';
        document.getElementById('modal-poem-title').style.fontSize = '';
        speedIndex = 1;
        poemAudioPlayer.playbackRate = 1;
        document.getElementById('modal-speed-btn').innerText = '1x';
        // 渲染前言（如果有）—— 小字、斜体、与正文区分
        let poemHtml = '';
        if (itemData.preface) {
            poemHtml += '<div class="poem-preface">' + itemData.preface + '</div>';
        }
        const poemLines = itemData.fullText.split('\n');
        poemHtml += poemLines.map((line, i) =>
            '<div class="poem-line" data-line="' + i + '">' + (line || '&nbsp;') + '</div>'
        ).join('');
        fullTextEl.innerHTML = poemHtml;
        currentLineTimings = []; // 重置时间轴，等音频 metadata 加载后再计算
        useAnalyzedTimings = false; // 重置预分析标记
        lastHighlightLineIdx = -1; // 重置高亮行号

        document.getElementById('modal-background-text').innerText = itemData.background;

        // 逐句释义：如果数据中有 annotation 字段，则渲染释义并显示切换按钮
        const annoBtn = document.getElementById('annotation-toggle-btn');
        const annoDiv = document.getElementById('modal-annotation');
        annotationExpanded = false;
        annoDiv.style.display = 'none';
        if (itemData.annotation) {
            // 格式：原文|译文\n原文|译文
            const annoLines = itemData.annotation.split('\n');
            annoDiv.innerHTML = annoLines.map(line => {
                const parts = line.split('|');
                if (parts.length >= 2) {
                    return '<div class="anno-line"><div class="anno-original">' + parts[0] + '</div><div class="anno-translation">' + parts[1] + '</div></div>';
                }
                return '<div class="anno-line"><div class="anno-translation">' + line + '</div></div>';
            }).join('');
            annoBtn.style.display = 'block';
            annoBtn.innerHTML = '📖 展开逐句释义';
        } else {
            annoBtn.style.display = 'none';
        }

        // 设置收藏按钮状态
        const favBtn = document.getElementById('modal-fav-btn');
        favBtn.style.display = 'block';
        const isFav = ProgressManager.isFav(itemData._uniqueId);
        favBtn.innerHTML = isFav ? '★ 已收藏' : '☆ 收藏';
        favBtn.classList.toggle('active', isFav);

        const audioBtn = document.getElementById('modal-audio-control');
        const progressContainer = document.getElementById('audio-progress-container');

        // 核心逻辑：如果数据中存在 audio 文件路径，则加载并自动播放
        if (itemData.audio) {
            poemAudioPlayer.src = itemData.audio;
            progressContainer.style.display = 'block';
            document.getElementById('audio-progress-bar').style.width = '0%';
            audioBtn.style.display = 'block';
            document.getElementById('modal-speed-btn').style.display = 'block';

            // 音频元数据加载后，计算每句的高亮时间段（带 readyState 兜底）
            const trySetupTimings = function() {
                if (poemAudioPlayer.duration && !isNaN(poemAudioPlayer.duration)) {
                    setupLineTimings(itemData.fullText, poemAudioPlayer.duration);
                    return true;
                }
                return false;
            };
            // 如果元数据已就绪则直接计算，否则监听事件
            if (!trySetupTimings()) {
                poemAudioPlayer.onloadedmetadata = trySetupTimings;
                // canplay 作为兜底（某些浏览器 loadedmetadata 不触发）
                poemAudioPlayer.oncanplay = function() {
                    if (currentLineTimings.length === 0) trySetupTimings();
                };
            }

            // 瞬间自动播放音频
           poemAudioPlayer.play().then(() => {
                audioBtn.innerHTML = '🔊 暂停朗读';
                audioBtn.classList.add('playing');
                if(isPlaying) bgm.volume = 0.2;
                // 异步预分析音频停顿点（不干扰播放，失败则沿用估算时间轴）
                if (!useAnalyzedTimings) {
                    analyzeAudioForSilence(itemData.audio, itemData.fullText).then(timings => {
                        if (timings && timings.length > 0) {
                            currentLineTimings = timings;
                            useAnalyzedTimings = true;
                        }
                    });
                }
            }).catch(e => {
                console.warn("音频加载或播放失败", e);
                audioBtn.innerHTML = '🔈 播放朗读';
                audioBtn.classList.remove('playing');
            });

            // 音频自然播放结束后的状态重置
            poemAudioPlayer.onended = () => {
                audioBtn.innerHTML = '🔈 播放朗读';
                audioBtn.classList.remove('playing');
                document.querySelectorAll('.poem-line').forEach(el => el.classList.remove('highlight', 'read'));
                if(isPlaying) bgm.volume = 1.0;
            };
        } else {
            // 如果这首词没有配置音频文件，则隐藏控件并确保静音
            audioBtn.style.display = 'none';
            document.getElementById('modal-speed-btn').style.display = 'none';
            progressContainer.style.display = 'none';
            poemAudioPlayer.pause();
            if(isPlaying) bgm.volume = 1.0;
        }

        // 显示卷轴弹窗
        const modal = document.getElementById('poem-modal');
        modal.style.display = 'flex';
        setTimeout(() => modal.style.opacity = '1', 10);

        // 联动 Echarts 地图高亮
        if(myChart) {
            myChart.setOption({ series: [ {}, {}, {}, {}, { data: [itemData] }, {} ] });
            setTimeout(() => {
                let mapData = myChart.getOption().series[3].data;
                let dataIndex = mapData.findIndex(d => d._uniqueId === itemData._uniqueId);
                if (dataIndex !== -1) myChart.dispatchAction({ type: 'showTip', seriesIndex: 3, dataIndex: dataIndex });
            }, 100);
        }
    };
        
        // 收藏切换
        window.toggleFavorite = function() {
            if (!currentModalItemId) return;
            const isFav = ProgressManager.toggleFav(currentModalItemId);
            const btn = document.getElementById('modal-fav-btn');
            btn.innerHTML = isFav ? '★ 已收藏' : '☆ 收藏';
            btn.classList.toggle('active', isFav);
            updateCardBadges(currentModalItemId);
        };

        // 字体大小调节
        let modalFontScale = 1.0;
        window.changeFontSize = function(delta) {
            modalFontScale = Math.max(0.7, Math.min(1.8, modalFontScale + delta * 0.1));
            const fullText = document.getElementById('modal-full-text');
            const anno = document.getElementById('modal-annotation');
            const bg = document.getElementById('modal-background-text');
            const title = document.getElementById('modal-poem-title');
            fullText.style.fontSize = (22 * modalFontScale) + 'px';
            if (anno) {
                anno.querySelectorAll('.anno-original').forEach(el => el.style.fontSize = (17 * modalFontScale) + 'px');
                anno.querySelectorAll('.anno-translation').forEach(el => el.style.fontSize = (16 * modalFontScale) + 'px');
            }
            bg.style.fontSize = (18 * modalFontScale) + 'px';
            title.style.fontSize = (36 * modalFontScale) + 'px';
        };

        // 朗读语速切换
        const speedOptions = [0.75, 1, 1.25, 1.5];
        let speedIndex = 1;
        window.cycleAudioSpeed = function() {
            speedIndex = (speedIndex + 1) % speedOptions.length;
            const rate = speedOptions[speedIndex];
            poemAudioPlayer.playbackRate = rate;
            document.getElementById('modal-speed-btn').innerText = rate + 'x';
        };

        // 导出诗词卡片（以视频截图为背景）
        window.exportPoemCard = function() {
            if (!currentModalItemId) return;
            const itemData = allData.find(d => d._uniqueId === currentModalItemId);
            if (!itemData) return;

            const bgVideo = document.getElementById('modal-bg-video');
            const title = itemData.poem;
            const year = itemData.year;
            const location = itemData.name;
            const poem = itemData.fullText;
            const bgText = itemData.background || '';

            // 截取视频当前帧
            let videoFrameUrl = null;
            if (bgVideo && bgVideo.videoWidth > 0 && bgVideo.readyState >= 2) {
                try {
                    const tmpCanvas = document.createElement('canvas');
                    tmpCanvas.width = bgVideo.videoWidth;
                    tmpCanvas.height = bgVideo.videoHeight;
                    const tmpCtx = tmpCanvas.getContext('2d');
                    tmpCtx.drawImage(bgVideo, 0, 0);
                    videoFrameUrl = tmpCanvas.toDataURL('image/jpeg', 0.9);
                } catch(e) {
                    console.warn('视频截图失败（可能跨域），使用渐变背景', e);
                }
            }

            // 背景优先级：自选图片（随机抽取一张） > 视频截图 > 渐变
        let randomBgImage = null;
        if (cardBgImages.length > 0) {
            randomBgImage = cardBgImages[Math.floor(Math.random() * cardBgImages.length)];
        }
        const bgUrl = randomBgImage || videoFrameUrl;
            const cardBg = bgUrl ? `url(${bgUrl}) center/cover` : 'radial-gradient(ellipse at center, #2a0808 0%, #0a0202 100%)';

            // 创建卡片容器（高度自适应，移动端缩小尺寸避免截断）
            const isMobileCard = window.innerWidth <= 768;
            const cardWidth = isMobileCard ? 350 : 750;
            const cardPadding = isMobileCard ? '22px 20px 20px' : '45px 40px 40px';
            const cardBorder = isMobileCard ? '2px' : '3px';
            const card = document.createElement('div');
            card.style.cssText = `
                position: fixed; left: -9999px; top: 0;
                width: ${cardWidth}px;
                background: ${cardBg};
                border: ${cardBorder} solid #FFD700; border-radius: 16px;
                overflow: hidden;
                padding: ${cardPadding}; box-sizing: border-box;
            `;

            // 半透明遮罩层
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                background: linear-gradient(to bottom, rgba(10,2,2,0.75) 0%, rgba(10,2,2,0.55) 40%, rgba(10,2,2,0.85) 100%);
                z-index: 0;
            `;
            card.appendChild(overlay);

            // 金色内边框
            const innerBorder = document.createElement('div');
            innerBorder.style.cssText = `
                position: absolute; top: 12px; left: 12px; right: 12px; bottom: 12px;
                border: 1px solid rgba(255,215,0,0.4); border-radius: 10px; z-index: 0; pointer-events: none;
            `;
            card.appendChild(innerBorder);

            // 内容容器
            const content = document.createElement('div');
            content.style.cssText = `position: relative; z-index: 1;`;

            // 标题（毛体）
            const titleEl = document.createElement('div');
            titleEl.innerText = title;
            titleEl.style.cssText = `
                text-align: center; font-size: ${isMobileCard ? 22 : 38}px; color: #FFD700; font-weight: bold;
                text-shadow: 0 2px 12px rgba(0,0,0,0.95); margin-bottom: ${isMobileCard ? 4 : 8}px; letter-spacing: ${isMobileCard ? 2 : 4}px;
                font-family: 'MaoFont', 'STKaiti', 'KaiTi', '楷体', serif;
            `;
            content.appendChild(titleEl);

            // 年份地点
            const metaEl = document.createElement('div');
            metaEl.innerText = year + '年 · ' + location;
            metaEl.style.cssText = `
                text-align: center; font-size: ${isMobileCard ? 12 : 15}px; color: #d4a373; margin-bottom: ${isMobileCard ? 10 : 18}px;
                text-shadow: 0 1px 6px rgba(0,0,0,0.95);
            `;
            content.appendChild(metaEl);

            // 金色分隔线
            const divider = document.createElement('div');
            divider.style.cssText = `
                width: ${isMobileCard ? 40 : 60}px; height: 2px; background: #FFD700; margin: 0 auto ${isMobileCard ? 12 : 20}px;
                box-shadow: 0 0 8px rgba(255,215,0,0.5);
            `;
            content.appendChild(divider);

            // 诗词正文（楷体）
            const poemEl = document.createElement('div');
            poemEl.innerText = poem;
            poemEl.style.cssText = `
                font-size: ${isMobileCard ? 14 : 21}px; color: #ffffff; text-align: center;
                line-height: ${isMobileCard ? 1.8 : 2.0}; letter-spacing: ${isMobileCard ? 1 : 3}px; white-space: pre-wrap;
                text-shadow: 0 2px 8px rgba(0,0,0,0.95); margin-bottom: ${isMobileCard ? 14 : 24}px;
                font-family: 'STKaiti', 'KaiTi', '楷体', serif;
            `;
            content.appendChild(poemEl);

            // 背景介绍
            if (bgText) {
                const bgTitleEl = document.createElement('div');
                bgTitleEl.innerText = '创作背景';
                bgTitleEl.style.cssText = `
                    text-align: center; font-size: ${isMobileCard ? 12 : 15}px; color: #FFD700; font-weight: bold;
                    margin-bottom: ${isMobileCard ? 6 : 10}px; letter-spacing: 2px;
                `;
                content.appendChild(bgTitleEl);

                const bgEl = document.createElement('div');
                // 截断过长的背景文字
                const bgDisplay = bgText.length > 500 ? bgText.substring(0, 500) + '……' : bgText;
                bgEl.innerText = bgDisplay;
                bgEl.style.cssText = `
                    font-size: ${isMobileCard ? 11 : 14}px; color: #e0e0e0; line-height: ${isMobileCard ? 1.7 : 1.9}; letter-spacing: 1px;
                    text-indent: 2em; text-shadow: 0 1px 6px rgba(0,0,0,0.95);
                    background: rgba(0,0,0,0.35); border-left: ${isMobileCard ? 2 : 3}px solid #FFD700;
                    padding: ${isMobileCard ? '10px 12px' : '16px 18px'}; border-radius: 0 8px 8px 0;
                    font-family: 'Microsoft YaHei', sans-serif;
                `;
                content.appendChild(bgEl);
            }

            card.appendChild(content);

            // 底部水印 + 二维码（绝对定位右下角，不单独占行）
            const footer = document.createElement('div');
            footer.style.cssText = `
                position: absolute; bottom: ${isMobileCard ? 10 : 15}px; right: ${isMobileCard ? 12 : 18}px; z-index: 2;
                display: flex; align-items: center; gap: ${isMobileCard ? 6 : 8}px;
            `;
            // 左侧文字
            const footerText = document.createElement('div');
            footerText.style.cssText = `text-align: right;`;
            footerText.innerHTML = `
                <div style="font-size: ${isMobileCard ? 10 : 13}px; color: #FFD700; font-weight: bold; letter-spacing: 1px; font-family: 'STKaiti', '楷体', serif;">毛主席诗词全景地图</div>
                <div style="font-size: ${isMobileCard ? 8 : 10}px; color: rgba(212,163,115,0.85); margin-top: 2px; letter-spacing: 1px;">📱 扫码体验</div>
            `;
            footer.appendChild(footerText);
            // 右侧二维码
            const qrImg = document.createElement('img');
            const qrSize = isMobileCard ? 80 : 120;
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=' + qrSize + 'x' + qrSize + '&margin=2&data=' + encodeURIComponent(window.location.href);
            qrImg.crossOrigin = 'anonymous';
            qrImg.src = qrUrl;
            qrImg.style.cssText = `width: ${isMobileCard ? 40 : 60}px; height: ${isMobileCard ? 40 : 60}px; border: 2px solid rgba(255,215,0,0.5); border-radius: 6px; background: #fff; padding: 2px;`;
            footer.appendChild(qrImg);
            card.appendChild(footer);

            document.body.appendChild(card);

            // 等待二维码加载（最多 3 秒）后再截图，避免海报里二维码空白
            const qrLoadPromise = new Promise(resolve => {
                if (qrImg.complete) return resolve();
                qrImg.onload = () => resolve();
                qrImg.onerror = () => resolve(); // 失败也继续，至少文字水印在
                setTimeout(resolve, 3000);
            });

            qrLoadPromise.then(() => {
                // 用 html2canvas 截图并下载
                html2canvas(card, {
                    backgroundColor: '#0a0202',
                    scale: 2,
                    useCORS: true,
                    allowTaint: true
                }).then(canvas => {
                    // 用 blob 方式下载，兼容手机端
                    canvas.toBlob(function(blob) {
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.download = title + '_诗词卡片.png';
                        link.href = url;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }, 'image/png');
                    card.remove();
                }).catch(err => {
                    console.error('卡片生成失败', err);
                    card.remove();
                    alert('卡片生成失败，请重试');
                });
            });
        };

        // 逐句释义：展开/收起
        let annotationExpanded = false;
        window.toggleAnnotation = function() {
            annotationExpanded = !annotationExpanded;
            const annoDiv = document.getElementById('modal-annotation');
            const btn = document.getElementById('annotation-toggle-btn');
            if (annotationExpanded) {
                annoDiv.style.display = 'block';
                btn.innerHTML = '📖 收起逐句释义';
            } else {
                annoDiv.style.display = 'none';
                btn.innerHTML = '📖 展开逐句释义';
            }
        };

        window.closePoemModal = function() {
    const modal = document.getElementById('poem-modal');
    modal.style.opacity = '0';
    setTimeout(() => modal.style.display = 'none', 300);

    // 核心逻辑：关闭卡片时，强制暂停朗读音频并重置进度
    poemAudioPlayer.pause();
    poemAudioPlayer.currentTime = 0;

    // 清除诗句高亮与时间轴
    useAnalyzedTimings = false;
    currentLineTimings = [];
    lastHighlightLineIdx = -1;
    document.querySelectorAll('.poem-line').forEach(el => el.classList.remove('highlight', 'read'));

    // 隐藏收藏按钮
    document.getElementById('modal-fav-btn').style.display = 'none';

    const bgVideo = document.getElementById('modal-bg-video');
    if (bgVideo) {
        bgVideo.pause();
        bgVideo.removeAttribute('src');
        bgVideo.load();
    }

    // 恢复按钮样式与主背景音乐音量
    const audioBtn = document.getElementById('modal-audio-control');
    audioBtn.classList.remove('playing');
    if(isPlaying) bgm.volume = 1.0;

    // 取消地图高亮
    if(myChart) myChart.dispatchAction({ type: 'hideTip' });
};
            
        window.switchTab = function(type, el) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            el.classList.add('active'); currentTabFilter = type;
            if(tourTimer) stopTour();
            initSidebar();
            let mapDataToRender = allData;
            if (currentTabFilter === 'favorite') {
                const favSet = ProgressManager.getFavSet();
                mapDataToRender = allData.filter(d => favSet.has(d._uniqueId));
            } else if (currentTabFilter !== 'all') {
                mapDataToRender = allData.filter(d => d.stage === currentTabFilter);
            }
            updateMapData(mapDataToRender);
        };

        function initSidebar() {
            let total = allData.length, earlyCount = 0, midCount = 0;
            allData.forEach(item => { if(item.stage === 'early') earlyCount++; if(item.stage === 'mid') midCount++; });
            document.getElementById('stat-total').innerText = total; document.getElementById('stat-early').innerText = earlyCount; document.getElementById('stat-mid').innerText = midCount;
            updateProgressDisplay();

            let displayData = allData;
            if (currentTabFilter === 'favorite') {
                const favSet = ProgressManager.getFavSet();
                displayData = allData.filter(d => favSet.has(d._uniqueId));
            } else if (currentTabFilter !== 'all') {
                displayData = allData.filter(d => d.stage === currentTabFilter);
            }
            const listContainer = document.getElementById('school-list'); listContainer.innerHTML = '';

            // 收藏为空时的占位提示
            if (displayData.length === 0 && currentTabFilter === 'favorite') {
                listContainer.innerHTML = '<div style="text-align:center;color:#d4a373;padding:50px 20px;font-size:14px;line-height:2;">⭐ 还没有收藏的诗词<br><span style="font-size:12px;color:#888;">点击诗词详情中的「☆ 收藏」按钮来收藏</span></div>';
                return;
            }

            displayData.forEach(item => {
                let card = document.createElement('div');
                card.className = item.isImportant ? 'school-card important' : 'school-card';
                card.id = item._uniqueId;
                card.style.borderLeftColor = item.itemStyle.color; card.setAttribute('data-search', (item.name + item.year + item.poem).toLowerCase());
                let badgeHtml = item.isImportant ? '<div class="core-badge">🌟 不朽经典</div>' : '';
                card.innerHTML = `
                    <div class="card-year-badge">${item.year}</div>${badgeHtml}
                    <div class="fav-badge">⭐</div>
                    <div class="audio-indicator">🎵</div>
                    <div class="card-header"><div><span class="card-school-name" style="color:${item.itemStyle.color}">${item.name}</span></div><div class="card-header-right"><span class="card-province">${item.province}</span><span class="read-badge">✓ 已读</span></div></div>
                    <div class="card-students">📜 ${item.poem}</div>
                    <div class="read-more-btn" onclick="event.stopPropagation(); openPoemModal('${item._uniqueId}')">📖 深度赏析</div>
                `;
                // 应用已读/收藏状态
                if (ProgressManager.isRead(item._uniqueId)) card.classList.add('is-read');
                if (ProgressManager.isFav(item._uniqueId)) card.classList.add('is-fav');
                card.onclick = () => {
                    if (tourTimer) stopTour();
                    let idx = currentListData.findIndex(d => d._uniqueId === item._uniqueId);
                    if(idx !== -1) setTimeState(idx, true);
                };
                card.onmouseenter = () => {
                    if (!myChart) return;
                    let mapData = myChart.getOption().series[3].data;
                    let dataIndex = mapData.findIndex(d => d._uniqueId === item._uniqueId);
                    if(dataIndex !== -1) myChart.dispatchAction({ type: 'showTip', seriesIndex: 3, dataIndex: dataIndex });
                };
                card.onmouseleave = () => {
                    if (!myChart) return;
                    myChart.dispatchAction({ type: 'hideTip' });
                };
                listContainer.appendChild(card);
            });
        }

        window.filterList = function() {
            const keyword = document.getElementById('search-input').value.toLowerCase();
            document.querySelectorAll('.school-card').forEach(card => { card.style.display = card.getAttribute('data-search').includes(keyword) ? 'block' : 'none'; });
        };
        window.toggleSidebar = function() { document.getElementById('sidebar').classList.toggle('open'); };

        window.randomPoem = function() {
            if (tourTimer) stopTour();
            let randomIndex = Math.floor(Math.random() * currentListData.length);
            setTimeState(randomIndex, true); 
            openPoemModal(currentListData[randomIndex]);
        };

        window.toggleTour = function() {
            const tlBtn = document.getElementById('timeline-play-btn');
            if (tourTimer) { stopTour(); } 
            else {
                tlBtn.innerText = '⏸'; tlBtn.classList.add('playing');
                // 移动端巡航不弹侧边栏，保持地图全屏显示路线
                if(!isPlaying) document.getElementById('music-btn').click();
                
                // =========================================================
                // 👇 新增：当时间轴开始巡游时，启动星空粒子四字词库轮播
                // =========================================================
                if (window.startParticleIdiomShow && typeof shortMaoQuotes !== 'undefined') {
                    window.startParticleIdiomShow(shortMaoQuotes);
                }

                if (globalTourIndex >= currentListData.length - 1) {
                    globalTourIndex = -1;
                }

                const playNext = async () => { 
                    if(globalTourIndex >= currentListData.length - 1) { stopTour(); return; }
                    globalTourIndex++;
                    let currentItem = currentListData[globalTourIndex];
                    
                    setTimeState(globalTourIndex, true);

                    if (!currentItem.isImportant) {
                        tourTimer = setTimeout(playNext, 600); 
                    } else {
                        tourTimer = setTimeout(playNext, 5000); 
                    }
                };
                playNext(); 
            }
        };

        function stopTour() { 
            if(tourTimer) clearTimeout(tourTimer); 
            tourTimer = null; 
            const tlBtn = document.getElementById('timeline-play-btn');
            tlBtn.innerText = '▶'; tlBtn.classList.remove('playing'); 
            poemAudioPlayer.pause(); bgm.volume = 1.0;
            document.querySelectorAll('.school-card').forEach(el => el.classList.remove('playing-audio'));
            
            // =========================================================
            // 👇 新增：当时间轴停止或被打断时，停止四字词库轮播
            // =========================================================
            if (window.stopParticleIdiomShow) {
                window.stopParticleIdiomShow();
            }
        }

        window.takeSnapshot = function() {
            document.body.style.cursor = 'wait';

            const titleEl = document.getElementById('title');
            const originalStyle = titleEl.getAttribute('style') || '';
            titleEl.style.background = 'none';
            titleEl.style.color = '#FFD700';
            titleEl.style.textShadow = '0 0 15px rgba(255, 215, 0, 0.8), 2px 2px 4px rgba(0,0,0,0.8)';
            titleEl.style.webkitTextFillColor = 'initial';

            html2canvas(document.getElementById('main-content'), {
                useCORS: true,
                allowTaint: true,
                backgroundColor: '#2a0808',
                scale: window.innerWidth <= 768 ? 1.5 : 2,
                logging: false,
                ignoreElements: (element) => {
                    return element.classList && element.classList.contains('snapshot-hide');
                }
            }).then(canvas => {
                titleEl.setAttribute('style', originalStyle);
                titleEl.style.webkitTextFillColor = '';
                document.body.style.cursor = 'default';

                // 保存到全局变量供下载/分享使用
                window._lastPosterDataUrl = canvas.toDataURL('image/png');
                window._lastPosterCanvas = canvas; // 保留 canvas 供 blob 下载
                // 显示预览
                const img = document.getElementById('poster-preview-img');
                img.src = window._lastPosterDataUrl;
                document.getElementById('poster-share-modal').classList.add('active');
            }).catch(e => {
                titleEl.setAttribute('style', originalStyle);
                titleEl.style.webkitTextFillColor = '';
                console.error('海报生成失败', e);
                document.body.style.cursor = 'default';
                alert('海报生成失败，这可能是因为您的浏览器拦截了画布读取权限。');
            });
        };

        // ==================== 海报分享面板相关函数 ====================
        window.closePosterShare = function() {
            document.getElementById('poster-share-modal').classList.remove('active');
        };

        window.downloadPoster = function() {
            if (!window._lastPosterCanvas) return;
            // 用 blob 方式下载，兼容手机端浏览器
            window._lastPosterCanvas.toBlob(function(blob) {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = '毛主席诗词全景编年史地图.png';
                link.href = url;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                showPsToast('海报已开始下载');
            }, 'image/png');
        };

        window.copyShareLink = async function() {
            const url = window.location.href;
            const shareText = '毛主席诗词全景地图 · 一张图纵览65首伟人诗词，重温峥嵘岁月 ' + url;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(shareText);
                } else {
                    // 兼容老浏览器
                    const ta = document.createElement('textarea');
                    ta.value = shareText;
                    ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta); ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                showPsToast('链接已复制，去粘贴给朋友吧');
            } catch (e) {
                showPsToast('复制失败，请手动复制地址栏链接');
            }
        };

        window.shareToWechat = function() {
            // 微信内嵌浏览器才支持 wx-sdk，外部浏览器只能提示
            if (navigator.userAgent.toLowerCase().includes('micromessenger')) {
                showPsToast('请点击右上角 ··· 选择「发送给朋友」');
            } else {
                // 尝试 Web Share API（移动端有效）
                if (navigator.share) {
                    navigator.share({
                        title: '毛主席诗词全景地图',
                        text: '一张图纵览65首伟人诗词，重温峥嵘岁月',
                        url: window.location.href
                    }).catch(() => {});
                } else {
                    copyShareLink();
                    showPsToast('已复制链接，可粘贴到微信发送');
                }
            }
        };

        window.shareToWeibo = function() {
            const url = encodeURIComponent(window.location.href);
            const text = encodeURIComponent('毛主席诗词全景地图 · 一张图纵览65首伟人诗词，重温峥嵘岁月');
            window.open('https://service.weibo.com/share/share.php?url=' + url + '&title=' + text, '_blank', 'width=600,height=500');
        };

        function showPsToast(msg) {
            const t = document.getElementById('ps-toast');
            t.innerText = msg;
            t.classList.add('show');
            clearTimeout(window._psToastTimer);
            window._psToastTimer = setTimeout(() => t.classList.remove('show'), 2500);
        }

        // ==================== 弹窗字号调节（A-/A+） ====================
        const _mfBoxMap = {
            quiz: '.quiz-box',
            quoteWall: '.quote-wall-box',
            timeline: '.timeline-box',
            stats: '.stats-modal-box',
            longmarch: '.lm-box'
        };
        window.adjustModalFont = function(key, delta) {
            const box = document.querySelector(_mfBoxMap[key]);
            if (!box) return;
            let cur = parseFloat(box.style.getPropertyValue('--fs')) || 1;
            cur = Math.max(0.7, Math.min(2.0, Math.round((cur + delta) * 100) / 100));
            box.style.setProperty('--fs', cur);
            try { localStorage.setItem('mf_' + key, cur); } catch(e) {}
        };
        function restoreModalFont(key) {
            const box = document.querySelector(_mfBoxMap[key]);
            if (!box) return;
            let saved = 1;
            try { saved = parseFloat(localStorage.getItem('mf_' + key)) || 1; } catch(e) {}
            box.style.setProperty('--fs', saved);
        }

        // ==================== 关于本站弹窗 ====================
        window.openAboutModal = function() {
            document.getElementById('about-modal').classList.add('active');
        };
        window.closeAboutModal = function() {
            document.getElementById('about-modal').classList.remove('active');
        };
        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeAboutModal(); closeQuiz(); closeQuoteWall(); }
        });

        // ==================== 今日一诗 ====================
        window.openTodayPoem = function() {
            const now = new Date();
            const start = new Date(now.getFullYear(), 0, 0);
            const dayOfYear = Math.floor((now - start) / 86400000);
            const idx = dayOfYear % allData.length;
            if (tourTimer) stopTour();
            openPoemModal(allData[idx]);
        };

        // ==================== 诗词闯关（多题型，仅考读过的诗） ====================
        let quizStreak = 0;
        let quizBest = parseInt(localStorage.getItem('quizBestScore') || '0');
        let quizCurrent = null;
        let quizType = 'year'; // 'year' | 'location' | 'background'

        window.openQuiz = function() {
            restoreModalFont('quiz');
            // 门槛：至少读过 1 首诗
            const readCount = ProgressManager.getReadCount();
            if (readCount < 1) {
                const hint = document.getElementById('quiz-hint');
                const poemText = document.getElementById('quiz-poem-text');
                const opts = document.getElementById('quiz-options');
                const result = document.getElementById('quiz-result');
                document.getElementById('quiz-modal').classList.add('active');
                document.getElementById('quiz-streak').innerText = '0';
                document.getElementById('quiz-best').innerText = quizBest;
                hint.innerText = '📖 请先在地图上阅读至少一首诗词，再来闯关！';
                poemText.innerText = '当前已读：0 首\n\n阅读诗词后，题目将围绕你读过的作品展开。';
                poemText.style.fontSize = '16px';
                opts.innerHTML = '';
                result.innerHTML = '';
                result.style.display = 'none';
                return;
            }
            quizStreak = 0;
            document.getElementById('quiz-best').innerText = quizBest;
            document.getElementById('quiz-streak').innerText = '0';
            document.getElementById('quiz-modal').classList.add('active');
            nextQuizQuestion();
        };
        window.closeQuiz = function() {
            document.getElementById('quiz-modal').classList.remove('active');
        };

        // 获取读过的诗词列表
        function getReadPoems() {
            return allData.filter(d => ProgressManager.isRead(d._uniqueId));
        }

        window.nextQuizQuestion = function nextQuizQuestion() {
            const readPoems = getReadPoems();
            if (readPoems.length === 0) { closeQuiz(); return; }

            // 随机选题型
            const types = ['year', 'location', 'background'];
            quizType = types[Math.floor(Math.random() * types.length)];

            // 随机选一首读过的诗
            quizCurrent = readPoems[Math.floor(Math.random() * readPoems.length)];

            const hintEl = document.getElementById('quiz-hint');
            const poemEl = document.getElementById('quiz-poem-text');
            const optsDiv = document.getElementById('quiz-options');
            const resultDiv = document.getElementById('quiz-result');
            poemEl.style.fontSize = '';

            if (quizType === 'year') {
                // 题型1：猜年份
                hintEl.innerText = '这首诗写于哪一年？';
                poemEl.innerText = quizCurrent.fullText;
                const correct = quizCurrent.year;
                const options = [correct];
                while (options.length < 4) {
                    const d = 1910 + Math.floor(Math.random() * 67);
                    if (!options.includes(d) && Math.abs(d - correct) >= 4) options.push(d);
                }
                options.sort(() => Math.random() - 0.5);
                optsDiv.innerHTML = '';
                options.forEach(y => {
                    const btn = document.createElement('div');
                    btn.className = 'quiz-option';
                    btn.innerText = y + ' 年';
                    btn.onclick = () => checkQuiz(y, correct, 'year');
                    optsDiv.appendChild(btn);
                });
            } else if (quizType === 'location') {
                // 题型2：猜地点
                hintEl.innerText = '这首诗写于哪个地点？';
                poemEl.innerText = quizCurrent.fullText;
                const correctLoc = (quizCurrent.province || '') + (quizCurrent.name || '');
                const options = [correctLoc];
                while (options.length < 4) {
                    const rand = allData[Math.floor(Math.random() * allData.length)];
                    const loc = (rand.province || '') + (rand.name || '');
                    if (loc && !options.includes(loc)) options.push(loc);
                }
                options.sort(() => Math.random() - 0.5);
                optsDiv.innerHTML = '';
                options.forEach(loc => {
                    const btn = document.createElement('div');
                    btn.className = 'quiz-option';
                    btn.innerText = loc;
                    btn.onclick = () => checkQuiz(loc, correctLoc, 'location');
                    optsDiv.appendChild(btn);
                });
            } else {
                // 题型3：看背景猜诗
                hintEl.innerText = '这段创作背景出自哪首诗？';
                const bg = quizCurrent.background || '';
                poemEl.innerText = bg.length > 150 ? bg.substring(0, 150) + '……' : bg;
                const correctTitle = (quizCurrent.poem || '').replace(/[《》]/g, '');
                const options = [correctTitle];
                while (options.length < 4) {
                    const rand = readPoems[Math.floor(Math.random() * readPoems.length)];
                    const title = (rand.poem || '').replace(/[《》]/g, '');
                    if (title && !options.includes(title)) options.push(title);
                }
                options.sort(() => Math.random() - 0.5);
                optsDiv.innerHTML = '';
                options.forEach(title => {
                    const btn = document.createElement('div');
                    btn.className = 'quiz-option';
                    btn.innerText = '《' + title + '》';
                    btn.onclick = () => checkQuiz(title, correctTitle, 'background');
                    optsDiv.appendChild(btn);
                });
            }

            resultDiv.innerHTML = '';
            resultDiv.style.display = 'none';
        };

        function checkQuiz(picked, correct, type) {
            document.querySelectorAll('.quiz-option').forEach(opt => {
                opt.style.pointerEvents = 'none';
                const txt = opt.innerText.replace(/[《》年]/g, '').trim();
                const correctTxt = String(correct).replace(/[《》]/g, '').trim();
                if (txt === correctTxt) opt.classList.add('correct');
                else if (opt.innerText.includes(picked)) opt.classList.add('wrong');
            });

            const resultDiv = document.getElementById('quiz-result');
            const isCorrect = (picked === correct);
            if (isCorrect) {
                quizStreak++;
                if (quizStreak > quizBest) {
                    quizBest = quizStreak;
                    localStorage.setItem('quizBestScore', String(quizBest));
                }
                resultDiv.innerHTML = '<div class="quiz-correct">✓ 答对了！连对 ' + quizStreak + ' 题</div>';
            } else {
                quizStreak = 0;
                let correctDisplay = correct;
                if (type === 'year') correctDisplay = correct + ' 年';
                else if (type === 'background') correctDisplay = '《' + correct + '》';
                resultDiv.innerHTML = '<div class="quiz-wrong">✗ 正确答案：' + correctDisplay + '</div>';
            }

            const bg = quizCurrent.background || '';
            const poemTitle = (quizCurrent.poem || '').replace(/[《》]/g, '');
            resultDiv.innerHTML +=
                '<div class="quiz-info">《' + poemTitle + '》 · ' + quizCurrent.year + '年 · ' +
                (quizCurrent.province || '') + (quizCurrent.name || '') + '</div>' +
                '<div class="quiz-bg">' + (bg.length > 150 ? bg.substring(0, 150) + '……' : bg) + '</div>' +
                '<div class="quiz-next" onclick="nextQuizQuestion()">下一题 →</div>';
            resultDiv.style.display = 'block';
            document.getElementById('quiz-streak').innerText = quizStreak;
            document.getElementById('quiz-best').innerText = quizBest;
        }

        // ==================== 年代穿越时间线 ====================
        window.openTimeline = function() {
            restoreModalFont('timeline');
            const list = document.getElementById('timeline-list');
            list.innerHTML = '';
            // 按年份排序
            const sorted = [...allData].sort((a, b) => a.year - b.year);
            sorted.forEach(d => {
                const item = document.createElement('div');
                item.className = 'tl-item' + (ProgressManager.isRead(d._uniqueId) ? ' read' : '');
                item.innerHTML =
                    '<div class="tl-year">' + d.year + '</div>' +
                    '<div class="tl-poem">' + (d.poem || '').replace(/[《》]/g, '') + '</div>' +
                    '<div class="tl-quote">' + (d.quote || '') + '</div>' +
                    '<div class="tl-location">📍 ' + (d.province || '') + (d.name || '') + '</div>';
                item.onclick = () => {
                    closeTimeline();
                    setTimeout(() => { if (tourTimer) stopTour(); openPoemModal(d); }, 300);
                };
                list.appendChild(item);
            });
            document.getElementById('timeline-modal').classList.add('active');
        };
        window.closeTimeline = function() {
            document.getElementById('timeline-modal').classList.remove('active');
        };

        // ==================== 足迹统计仪表盘 ====================
        window.openStats = function() {
            restoreModalFont('stats');
            const content = document.getElementById('stats-content');
            const readSet = ProgressManager.getReadSet();
            const favSet = ProgressManager.getFavSet();
            const readCount = readSet.size;
            const favCount = favSet.size;
            const importantRead = allData.filter(d => d.isImportant && readSet.has(d._uniqueId)).length;
            const importantTotal = allData.filter(d => d.isImportant).length;

            // 省份统计
            const allProvinces = [...new Set(allData.map(d => d.province).filter(Boolean))];
            const readProvinces = new Set();
            allData.forEach(d => { if (readSet.has(d._uniqueId) && d.province) readProvinces.add(d.province); });

            // 时代统计
            const stages = [
                { key: 'early', name: '星火燎原', cls: 'early' },
                { key: 'mid', name: '长征抗战', cls: 'middle' },
                { key: 'late', name: '建国岁月', cls: 'late' }
            ];
            const stageBars = stages.map(s => {
                const total = allData.filter(d => d.stage === s.key).length;
                const read = allData.filter(d => d.stage === s.key && readSet.has(d._uniqueId)).length;
                const pct = total > 0 ? Math.round(read / total * 100) : 0;
                return '<div class="stats-bar-wrap">' +
                    '<div class="stats-bar-label"><span>' + s.name + '</span><span>' + read + '/' + total + '</span></div>' +
                    '<div class="stats-bar-bg"><div class="stats-bar-fill ' + s.cls + '" style="width:' + pct + '%"></div></div>' +
                '</div>';
            }).join('');

            // 省份标签
            const provTags = allProvinces.map(p =>
                '<span class="stats-province-tag' + (readProvinces.has(p) ? '' : ' unread') + '">' + p + '</span>'
            ).join('');

            content.innerHTML =
                '<div class="stats-grid">' +
                    '<div class="stats-card"><div class="stats-num">' + readCount + '/' + allData.length + '</div><div class="stats-lbl">已读诗词</div></div>' +
                    '<div class="stats-card"><div class="stats-num">' + importantRead + '/' + importantTotal + '</div><div class="stats-lbl">不朽经典</div></div>' +
                    '<div class="stats-card"><div class="stats-num">' + favCount + '</div><div class="stats-lbl">收藏</div></div>' +
                    '<div class="stats-card"><div class="stats-num">' + readProvinces.size + '/' + allProvinces.length + '</div><div class="stats-lbl">足迹省份</div></div>' +
                '</div>' +
                '<div style="margin-bottom:8px;color:#FFD700;font-size:15px;letter-spacing:2px;">时代进度</div>' +
                stageBars +
                '<div style="margin:16px 0 8px;color:#FFD700;font-size:15px;letter-spacing:2px;">足迹地图</div>' +
                '<div class="stats-provinces">' + provTags + '</div>' +
                '<div style="margin-top:20px;text-align:center;color:#c9b89a;font-size:13px;line-height:1.8;">' +
                    (readCount === 0 ? '尚未开始阅读，点击地图上的金色标记开始探索吧！' :
                     readCount < 10 ? '初窥门径 · 继续探索更多名篇' :
                     readCount < 30 ? '渐入佳境 · 你已领略半部诗史' :
                     readCount < allData.length ? '博闻强识 · 即将读完全部名篇！' : '融会贯通 · 你已读完全部诗词！') +
                '</div>';

            document.getElementById('stats-modal').classList.add('active');
        };
        window.closeStats = function() {
            document.getElementById('stats-modal').classList.remove('active');
        };

        // ==================== 长征专题巡展 ====================
        window.openLongMarch = function() {
            restoreModalFont('longmarch');
            const list = document.getElementById('lm-list');
            list.innerHTML = '';
            // 筛选长征时期（middle stage）的诗词，按年份排序
            const marchPoems = allData.filter(d => d.stage === 'mid').sort((a, b) => a.year - b.year);
            marchPoems.forEach(d => {
                const item = document.createElement('div');
                item.className = 'lm-item';
                item.innerHTML =
                    '<div class="lm-item-head">' +
                        '<span class="lm-year">' + d.year + '年</span>' +
                        '<span class="lm-poem">' + (d.poem || '').replace(/[《》]/g, '') + '</span>' +
                    '</div>' +
                    '<div class="lm-quote">' + (d.quote || '') + '</div>' +
                    '<div class="lm-location">📍 ' + (d.province || '') + (d.name || '') + '</div>';
                item.onclick = () => {
                    closeLongMarch();
                    setTimeout(() => { if (tourTimer) stopTour(); openPoemModal(d); }, 300);
                };
                list.appendChild(item);
            });
            document.getElementById('longmarch-modal').classList.add('active');
        };
        window.closeLongMarch = function() {
            document.getElementById('longmarch-modal').classList.remove('active');
        };

        // ==================== 金句墙 ====================
        window.openQuoteWall = function() {
            restoreModalFont('quoteWall');
            const content = document.getElementById('quote-wall-content');
            content.innerHTML = '';

            // 收集所有诗词名句（可点击跳转）
            const poemQuotes = allData.map((d, i) => ({ text: d.quote, index: i, year: d.year }));
            // 收集毛泽东经典语录（装饰性）
            const standalone = [
                ...shortMaoQuotes.map(q => ({ text: q, index: -1 })),
                ...longMaoQuotes.map(q => ({ text: q, index: -1 }))
            ];

            // 混合打乱
            const all = [...poemQuotes, ...standalone].sort(() => Math.random() - 0.5);

            all.forEach(q => {
                const div = document.createElement('div');
                div.className = q.index >= 0 ? 'quote-card clickable' : 'quote-card';
                div.innerText = q.text;
                if (q.index >= 0) {
                    div.title = '点击查看《' + (allData[q.index].poem || '').replace(/[《》]/g, '') + '》';
                    div.onclick = () => {
                        closeQuoteWall();
                        setTimeout(() => {
                            if (tourTimer) stopTour();
                            openPoemModal(allData[q.index]);
                        }, 300);
                    };
                }
                content.appendChild(div);
            });

            document.getElementById('quote-wall-modal').classList.add('active');
        };
        window.closeQuoteWall = function() {
            document.getElementById('quote-wall-modal').classList.remove('active');
        };
        window.addEventListener('resize', () => { if(myChart) myChart.resize(); starCanvas.width = window.innerWidth; starCanvas.height = window.innerHeight; });
        // --- 弹幕发射器 ---
function fireDanmaku(text) {
    const container = document.getElementById('danmaku-container');
    if (!container) return;

    const danmaku = document.createElement('div');
    danmaku.className = 'danmaku-item';
    danmaku.innerText = `“ ${text} ”`; 

    // 随机 Y 轴高度 (屏幕顶部 15% 到 80% 之间，移动端限制在 15%-45% 避免遮挡)
    const isMobile = window.innerWidth <= 768;
    const topPercent = 15 + Math.random() * (isMobile ? 30 : 65);
    danmaku.style.top = topPercent + '%';

    // 随机字体大小 (桌面 26-46px，移动端 14-20px)
    const fontSize = isMobile ? (14 + Math.random() * 6) : (26 + Math.random() * 20);
    danmaku.style.fontSize = fontSize + 'px';

    // 随机透明度 (0.6 到 1 之间)
    danmaku.style.opacity = 0.6 + Math.random() * 0.4;

    // 随机划过屏幕的时间 (桌面 8-16s，移动端 5-8s)
    const duration = isMobile ? (5 + Math.random() * 3) : (8 + Math.random() * 8);
    danmaku.style.animationDuration = duration + 's';

    container.appendChild(danmaku);

    // 弹幕划出屏幕后自动销毁内存
    setTimeout(() => {
        if (danmaku.parentNode) {
            danmaku.parentNode.removeChild(danmaku);
        }
    }, duration * 1000);

    // --- 弹幕队列控制系统 ---

}

// ===================================================================
// 鼠标点击名句特效系统 (长短句混合版)
// ===================================================================
document.addEventListener('click', function(e) {
    // 移动端禁用点击名句特效，避免遮挡小屏幕操作
    if (window.innerWidth <= 768) return;

    // 创建文字节点
    const quoteEl = document.createElement('span');
    quoteEl.className = 'click-quote-effect';

    // 核心修改：合并两个词库数组，让长短句共同参与随机抽取
    const combinedQuotes = [...shortMaoQuotes, ...longMaoQuotes]; 
    quoteEl.innerText = combinedQuotes[Math.floor(Math.random() * combinedQuotes.length)];

    // 随机生成鲜艳明亮的颜色
    const randomHue = Math.floor(Math.random() * 360);
    quoteEl.style.color = `hsl(${randomHue}, 80%, 65%)`;

    // 绝对定位到鼠标点击的确切坐标
    quoteEl.style.left = e.pageX + 'px';
    quoteEl.style.top = e.pageY + 'px';

    // 挂载到 body 上
    document.body.appendChild(quoteEl);

    // 在 1.2 秒动画结束后，及时销毁 DOM 节点
    setTimeout(() => {
        if (quoteEl.parentNode) {
            quoteEl.parentNode.removeChild(quoteEl);
        }
    }, 1200); 
});