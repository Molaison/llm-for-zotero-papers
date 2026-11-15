# Sleep pressure reshapes place field stability in the rodent hippocampus

# Abstract

Place cells in the rodent hippocampus fire at reliable locations in a familiar environment, yet the reliability of that code degrades when the animal has been kept awake beyond its usual rest period. We recorded from the dorsal hippocampus of freely moving rats across a controlled sleep restriction protocol and asked how accumulated sleep pressure changes the stability of individual place fields. Recordings were made in a circular track and in an open arena on alternating days, so that the same cells could be compared under two different behavioural demands. We found that place fields remained present after restriction but drifted between successive laps, and that the drift was largest for cells with the lowest baseline firing rate. Population decoding of position degraded in proportion to the drift, while the theta rhythm and running speed were unchanged. A single recovery sleep period restored both field stability and decoding accuracy to baseline within one session. These results indicate that sleep pressure acts on the spatial code through field stability rather than through the presence or the tuning width of individual fields.

# Introduction

The hippocampal place code is one of the clearest examples of a neural representation whose content can be read out directly from spiking activity. A place cell fires when the animal occupies a restricted part of the environment, and the ensemble of such cells supports an accurate estimate of position. The code is not static: fields remap between environments, they shift backwards along a familiar route with experience, and they can be reorganised by changes in reward or in task demand. These observations have made the place code a standard assay for how internal state shapes a representation.

Sleep is one of the internal states with the strongest claim on hippocampal function. Replay of waking trajectories during sleep has been linked to consolidation, and disrupting sleep after learning impairs later memory performance. Much less is known about the opposite direction, that is, how the representation behaves during waking while sleep pressure accumulates. Behavioural work shows that sustained wakefulness degrades spatial memory in rodents and in humans, but such measurements cannot say whether the underlying code is absent, noisy, or simply read out less well.

We designed the present study to separate those possibilities. By recording the same neurons across a graded sleep restriction protocol, and by analysing field presence, field width, and field stability separately, we could ask which property of the code tracks sleep pressure. We also measured the theta rhythm and the running speed on every session, because both are known to modulate place field properties and both could confound a comparison across days.

# Methods

Twelve adult male rats were implanted with movable tetrode arrays targeting the dorsal hippocampus. After recovery, animals were trained to run laps on a circular track for a liquid reward, and separately to forage for scattered food in a square open arena. Training continued until lap times were stable across three consecutive sessions, which took between nine and fourteen days.

Sleep restriction was imposed with gentle handling during the first six hours of the rest phase. Restriction days alternated with undisturbed days, and the order of the track and arena sessions was counterbalanced across animals. Electroencephalographic and electromyographic signals were recorded continuously and scored in ten second epochs to verify that restriction reduced total sleep time without producing prolonged immobility during the recording session itself.

Spikes were sorted offline with a combination of automatic clustering and manual refinement, and only clusters with a clean refractory period and stable amplitude across the session were retained. Place fields were defined as contiguous regions in which the occupancy normalised firing rate exceeded twenty per cent of the peak rate for at least three adjacent bins. Field stability was quantified as the correlation between the rate maps of alternate laps, and decoding was performed with a standard Bayesian estimator trained on odd laps and tested on even laps. Statistical comparisons used linear mixed models with animal as a random effect, and all reported intervals are ninety five per cent confidence intervals.

# Results

Sleep restriction did not remove place fields. The proportion of recorded units classified as place cells was similar on restricted and undisturbed days in both environments, and the mean field width differed by less than three per cent. Peak firing rates were slightly lower after restriction, but the difference did not reach significance once running speed was included in the model.

Field stability told a different story. The lap to lap correlation of rate maps fell markedly after restriction on the circular track, and the same effect appeared in the open arena when stability was computed between the first and second halves of the session. The drop in stability grew with the number of consecutive restriction days, so the effect accumulated rather than saturating after a single day. Cells with low baseline firing rates were the most affected, and the relationship between baseline rate and stability loss was monotonic across the recorded population.

Position decoding followed field stability rather than field presence. Median decoding error increased after restriction in both environments, and the increase was predicted by the stability measure of the contributing cells but not by their field width or peak rate. Theta frequency and theta power were unchanged, and running speed distributions overlapped across conditions, which rules out the simplest behavioural explanations for the decoding result.

Recovery was fast. After a single undisturbed rest period, lap to lap correlation and decoding error both returned to values indistinguishable from baseline, and the recovery was complete in every animal that completed the protocol. The speed of recovery suggests that the effect of sleep pressure on the spatial code is a reversible change in state rather than a lasting reorganisation of the map.

# Discussion

Our recordings show that sleep pressure degrades the hippocampal spatial code through stability rather than through the existence or the shape of place fields. That distinction matters for how the effect should be modelled. A loss of fields would suggest that the inputs carrying spatial information are themselves compromised, whereas a loss of stability with preserved tuning points to a change in how reliably an existing map is expressed from moment to moment.

The dependence on baseline firing rate offers a mechanistic hint. Low rate cells are thought to depend more on precisely timed excitation to reach threshold, so they should be the first to lose reliability when excitability or inhibitory balance drifts. Our data cannot identify the cellular mechanism, but they do constrain it: any candidate must degrade reliability while leaving tuning width and theta dynamics intact, and must reverse within a single recovery sleep period.

Several limitations should be noted. The gentle handling procedure used to enforce restriction introduces mild stress, which we did not measure directly, and our recordings were confined to the dorsal hippocampus, so we cannot say whether ventral representations behave the same way. Finally, decoding was performed offline with a fixed estimator, and a downstream reader with access to the current state might compensate for some of the drift we report.

# References

Aarons R and Feo L (2019) Reliability of spatial tuning under sustained wakefulness. Journal of Synthetic Neuroscience 14: 201-219.

Dupin C, Halvorsen G and Okonjo T (2021) Lap to lap stability as a measure of map expression. Reports in Systems Neuroscience 6: 55-71.

Ibarra K and Mbeki S (2018) Bayesian decoding of position from small ensembles. Methods in Neural Analysis 30: 410-428.

Nowak V, Rasmussen D and Sandoval N (2022) Recovery sleep restores hippocampal coding after restriction. Sleep and Memory Letters 11: 88-97.
