let myChart = null;
        let isMapLocked = window.innerWidth <= 768; 

        function checkEcharts() {
            if (typeof echarts === 'undefined') {
                document.getElementById('map-box').innerHTML = `<div style="color:#FFD700; font-size:22px; text-align:center; padding-top:40vh; font-family: '楷体', serif; text-shadow: 0 0 10px rgba(255,51,51,0.8); line-height: 2;">⚠️ 地图引擎 (ECharts) 加载失败</div>`;
                return false;
            }
            if(!myChart) myChart = echarts.init(document.getElementById('map-box'));
            return true;
        }

        // ★ 修复跨域请求：利用 referrerPolicy 绕过阿里云防盗链机制
        // ★ 增强：在线请求失败时回退到本地 GeoJSON 副本，保证离线/弱网可用
        async function fetchMapData(adcode) {
            try {
                const res = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`, {
                    referrerPolicy: 'no-referrer' // 隐藏本地 Referer，完美规避 403 Forbidden 报错
                });
                if (!res.ok) throw new Error('在线地图数据 HTTP ' + res.status);
                return await res.json();
            } catch (e) {
                console.warn('在线地图数据获取失败，回退到本地副本:', e.message);
                // 本地兜底：仅支持全国地图（adcode=100000）
                if (adcode === '100000') {
                    const localRes = await fetch('data/china.json');
                    if (!localRes.ok) throw new Error('本地地图数据也加载失败');
                    return await localRes.json();
                }
                throw e;
            }
        }

        window.renderChinaMap = async function() {
            if (!checkEcharts()) return; 
            try { 
                myChart.showLoading({ text: '地图数据连接中...', color: '#FFD700', textColor: '#fff', maskColor: 'rgba(5,1,1,0.9)' });
                const geoJson = await fetchMapData('100000'); 
                echarts.registerMap('china', geoJson); 
                renderMap('china'); 
                
                document.getElementById('lock-btn').innerText = isMapLocked ? '🔒' : '🔓';
                document.getElementById('lock-btn').classList.toggle('locked', isMapLocked);
            } catch (e) {
                myChart.hideLoading();
                // 如果用户本身断网，则展示错误提示
                document.getElementById('map-box').innerHTML = `<div style="color:#FFD700; font-size:22px; text-align:center; padding-top:40vh; font-family: '楷体', serif; text-shadow: 0 0 10px rgba(255,51,51,0.8); line-height: 2;">⚠️ 地图加载失败，请检查网络连接</div>`;
            }
        };

        function updateMapData(filteredData) {
            if(!myChart) return;
            currentListData = filteredData;
            initTimeline();
            setTimeState(currentListData.length - 1, false); 
        }

        function renderMap(mapName) {
            if(!myChart) return;
            
            let longMarchNodes = [
                {name: '瑞金(起点)', value: [116.02, 25.88]}, {name: '于都', value: [115.40, 25.95]}, {name: '湘江战役', value: [111.07, 25.93]},
                {name: '黎平', value: [109.13, 26.23]}, {name: '强渡乌江', value: [107.55, 27.32]}, {name: '遵义会议', value: [106.92, 27.73]},
                {name: '娄山关', value: [106.82, 28.00]}, {name: '四渡赤水', value: [106.15, 28.38]}, {name: '巧渡金沙江', value: [102.87, 26.10]},
                {name: '强渡大渡河', value: [102.23, 29.33]}, {name: '飞夺泸定桥', value: [102.23, 29.91]}, {name: '爬雪山', value: [102.69, 30.68]},
                {name: '懋功会师', value: [102.35, 30.99]}, {name: '过草地', value: [102.24, 31.90]}, {name: '腊子口', value: [103.88, 34.05]},
                {name: '六盘山', value: [106.15, 35.63]}, {name: '吴起镇会师', value: [108.17, 36.92]}, {name: '延安(终点)', value: [109.49, 36.58]}
            ];
            let fullLongMarchRoute = longMarchNodes.map(item => item.value);

            let option = {
                backgroundColor: 'transparent',
                tooltip: {
                    trigger: 'item', padding: 0, backgroundColor: 'transparent', borderColor: 'transparent', borderWidth: 0,
                    formatter: function (params) {
                        const isMobile = window.innerWidth <= 768;
                        if(params.seriesIndex === 2) {
                            return `<div style="padding: ${isMobile?'8px 10px':'12px'}; background: rgba(20,5,5,0.95); border: 1px solid #ba2a24; color: #FFD700; border-radius: 4px; font-weight: bold; box-shadow: 0 0 15px rgba(186,42,36,0.5); font-family: '楷体', serif; font-size: ${isMobile?'12px':'14px'};">🌟 长征终点：延安<br><span style="font-size: ${isMobile?'11px':'13px'}; color: #d4a373; font-weight: normal; margin-top: 5px; display: inline-block;">1935年-1948年 中共中央所在地</span></div>`;
                        }
                        if(params.seriesType === 'scatter' || params.seriesType === 'effectScatter') {
                            if (!params.data.poem) return; 
                            if (isMobile) {
                                return `
                                    <div style="background: linear-gradient(145deg, #1e0b0b 0%, #0f0404 100%); border: 1px solid rgba(212, 163, 115, 0.4); border-radius: 6px; padding: 10px 12px; min-width: 180px; max-width: 240px; box-shadow: 0 4px 15px rgba(0,0,0,0.7); position: relative;">
                                        <div style="display:flex; align-items:baseline; margin-bottom:6px; border-bottom:1px solid rgba(212,163,115,0.2); padding-bottom:5px;">
                                            <span style="font-weight:bold; font-size:16px; color:#d4a373; font-family: 'Times New Roman', serif; line-height: 1;">${params.data.year}</span>
                                            <span style="font-size:12px; color:#a87b51; margin-left:6px;">年 · ${params.name}</span>
                                        </div>
                                        <div style="color:#FFD700; font-size:15px; margin-bottom:6px; font-family: 'KaiTi','楷体','STKaiti', serif; font-weight:normal;">${params.data.poem}</div>
                                        <div style="font-size:12px; color: #e6d5c3; line-height: 1.5; font-family: 'KaiTi','楷体', serif;">${params.data.quote}</div>
                                    </div>
                                `;
                            }
                            const randomShortQ = shortMaoQuotes[params.dataIndex % shortMaoQuotes.length] || '星火燎原';
                            return `
                                <div style="background: linear-gradient(145deg, #1e0b0b 0%, #0f0404 100%); border: 1px solid rgba(212, 163, 115, 0.4); border-radius: 6px; padding: 22px; min-width: 280px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8), inset 0 0 15px rgba(212,163,115,0.05); position: relative; overflow: hidden;">
                                    <div style="position: absolute; right: 15px; top: 50%; transform: translateY(-50%); color: rgba(212, 163, 115, 0.12); font-family: 'MaoFont', 'STXingkai', 'KaiTi', '楷体', serif; font-size: 32px; writing-mode: vertical-rl; letter-spacing: 4px; user-select: none; pointer-events: none; white-space: nowrap;">${randomShortQ}</div>
                                    <div style="display:flex; align-items:baseline; margin-bottom:12px; border-bottom:1px solid rgba(212,163,115,0.2); padding-bottom:8px; width: 75%; position: relative; z-index: 1;">
                                        <span style="font-weight:bold; font-size:24px; color:#d4a373; font-family: 'Times New Roman', serif; line-height: 1;">${params.data.year}</span>
                                        <span style="font-size:14px; color:#a87b51; margin-left:8px; margin-bottom:2px;">年 · ${params.name}</span>
                                    </div>
                                    <div style="color:#FFD700; font-size:22px; margin-bottom:12px; font-family: 'KaiTi', '楷体', 'STKaiti', serif; font-weight:normal; text-shadow: 0 2px 4px rgba(0,0,0,0.8); position: relative; z-index: 1;">${params.data.poem}</div>
                                    <div style="background: rgba(212, 163, 115, 0.05); border-radius: 4px; padding: 12px 15px; font-style: italic; font-size: 15px; color: #e6d5c3; border-left: 3px solid #ba2a24; line-height: 1.6; margin-bottom: 12px; position: relative; font-family: 'KaiTi', '楷体', serif; z-index: 1;">
                                        <span style="position: absolute; top: -8px; left: 5px; font-size: 32px; color: rgba(186,42,36,0.15); font-family: serif; line-height: 1;">"</span>
                                        <span style="position: relative; z-index: 1; text-shadow: 0 1px 2px rgba(0,0,0,0.8);">${params.data.quote}</span>
                                    </div>
                                    <div style="text-align: right; font-size: 12px; color: #777; letter-spacing: 1px; display: flex; justify-content: flex-end; align-items: center; position: relative; z-index: 1;">
                                        <span style="display: inline-block; width: 6px; height: 6px; background: #d4a373; border-radius: 50%; margin-right: 6px; box-shadow: 0 0 5px #d4a373;"></span>请在右侧列表展开深度赏析
                                    </div>
                                </div>
                            `;
                        }
                    }
                },
                geo: {
                    map: mapName, roam: !isMapLocked, scaleLimit: { min: 0.8, max: 6 }, 
                    layoutCenter: window.innerWidth > 768 ? ['45%', '50%'] : ['50%', '50%'], layoutSize: window.innerWidth > 768 ? '120%' : '150%', 
                    itemStyle: { 
                        areaColor: { type: 'radial', x: 0.5, y: 0.5, r: 0.8, colorStops: [{ offset: 0, color: '#3a1111' }, { offset: 1, color: '#0a0202' }] },
                        borderColor: { type: 'linear', x: 0, y: 0, x2: 1, y2: 1, colorStops: [{ offset: 0, color: '#FFD700' }, { offset: 0.5, color: '#fff' }, { offset: 1, color: '#d4a373' }] },
                        borderWidth: 1.5, shadowColor: 'rgba(255, 51, 51, 0.4)', shadowBlur: 35, shadowOffsetY: 18, shadowOffsetX: 5
                    },
                    emphasis: { 
                        itemStyle: { 
                            areaColor: { type: 'radial', x: 0.5, y: 0.5, r: 0.8, colorStops: [{ offset: 0, color: '#6e1a1a' }, { offset: 1, color: '#2a0505' }] },
                            borderColor: '#ffffff', borderWidth: 2, shadowColor: 'rgba(255, 215, 0, 0.8)', shadowBlur: 45, shadowOffsetY: 0, shadowOffsetX: 0 
                        }, label: { show: false }
                    }
                },
                series: [
                    { type: 'lines', zlevel: 0, coordinateSystem: 'geo', polyline: true, data: [{ coords: fullLongMarchRoute }], lineStyle: { color: '#ba2a24', width: 2.5, type: 'solid', opacity: 0.6, shadowColor: 'rgba(186, 42, 36, 0.8)', shadowBlur: 10 }, effect: { show: true, period: 8, trailLength: 0.4, symbol: 'arrow', symbolSize: 6, color: '#FFD700' }, silent: true },
                    { type: 'scatter', coordinateSystem: 'geo', zlevel: 1, data: longMarchNodes, symbolSize: 4, itemStyle: { color: '#FF4500' }, label: { show: true, position: 'right', formatter: '{b}', fontSize: 11, color: 'rgba(255, 215, 0, 0.85)', textShadowBlur: 4, textShadowColor: '#000', offset: [5, 0] }, silent: true },
                    { type: 'effectScatter', coordinateSystem: 'geo', zlevel: 2, data: [{ name: '延安', value: [109.49, 36.58], itemStyle: { color: '#ff2a2a', shadowBlur: 15, shadowColor: '#ff2a2a' } }], symbol: 'path://M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z', symbolSize: 22, rippleEffect: { brushType: 'stroke', scale: 5, period: 2.5 } },
                    { type: 'scatter', coordinateSystem: 'geo', data: [], symbolSize: 6, itemStyle: { color: 'rgba(255, 215, 0, 0.8)', shadowBlur: 10, shadowColor: '#FFD700' }, zlevel: 3 },
                    { type: 'effectScatter', coordinateSystem: 'geo', data: [], symbolSize: 20, symbol: 'circle', rippleEffect: { brushType: 'stroke', scale: 4.5 }, zlevel: 5 },
                    { type: 'lines', zlevel: 4, effect: { show: true, period: 3, trailLength: 0.5, symbol: 'arrow', symbolSize: 8 }, lineStyle: { width: 3, opacity: 0.8, curveness: 0.3, color: '#FFD700', shadowColor: '#FFD700', shadowBlur: 10 }, data: [] }
                ]
            };
            myChart.setOption(option, true);
            myChart.hideLoading();

            initTimeline();
            setTimeState(currentListData.length - 1, false);
        }