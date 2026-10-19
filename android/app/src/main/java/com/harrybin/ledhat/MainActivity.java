package com.harrybin.ledhat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApproachBeaconPlugin.class);
        registerPlugin(SoundDetectionPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
